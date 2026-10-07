import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, dirname } from "node:path";
import {
  loadSkillsFromDir,
  parseFrontmatter,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import {
  skillNameSchema,
  skillWriteSchema,
  type SkillDetail,
  type SkillSummary,
  type SkillWrite,
} from "@mp-pi/contracts";
import { z } from "zod";
import { AppError, ConflictError, NotFoundError } from "../core/errors.js";

const activationSchema = z.record(skillNameSchema, z.boolean());
const metadataSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
});

function inside(path: string, root: string): boolean {
  const location = relative(resolve(root), path);
  return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
}

export class SkillService {
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly builtinDir: string,
    private readonly dataDir: string,
  ) {}

  private root(userId: string): string {
    return join(this.dataDir, "personal-skills", createHash("sha256").update(userId).digest("hex"));
  }

  private activation(userId: string): Record<string, boolean> {
    const path = join(this.root(userId), "activation.json");
    return existsSync(path) ? activationSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : {};
  }

  private discover(userId: string): LoadSkillsResult {
    const builtin = loadSkillsFromDir({ dir: this.builtinDir, source: "builtin" });
    const personal = loadSkillsFromDir({ dir: this.root(userId), source: "user" });
    for (const [result, root] of [
      [builtin, this.builtinDir],
      [personal, this.root(userId)],
    ] as const) {
      for (const skill of result.skills) {
        if (!inside(realpathSync(skill.filePath), root)) {
          throw new ConflictError("技能文件必须位于自己的技能目录中");
        }
      }
    }
    const skills = new Map(
      [...builtin.skills, ...personal.skills].map((skill) => [skill.name, skill]),
    );
    return {
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      diagnostics: [...builtin.diagnostics, ...personal.diagnostics],
    };
  }

  load(userId: string): LoadSkillsResult {
    const result = this.discover(userId);
    const activation = this.activation(userId);
    return { ...result, skills: result.skills.filter((skill) => activation[skill.name] !== false) };
  }

  list(userId: string): SkillSummary[] {
    const activation = this.activation(userId);
    return this.discover(userId).skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: inside(skill.filePath, this.root(userId)) ? "personal" : "builtin",
      enabled: activation[skill.name] !== false,
    }));
  }

  get(userId: string, name: string): SkillDetail {
    skillNameSchema.parse(name);
    const skill = this.discover(userId).skills.find((item) => item.name === name);
    const summary = this.list(userId).find((item) => item.name === name);
    if (!skill || !summary) {
      throw new NotFoundError("未找到该技能");
    }
    return { ...summary, content: readFileSync(skill.filePath, "utf8") };
  }

  read(userId: string, name: string): { name: string; content: string } {
    const skill = this.get(userId, name);
    if (!skill.enabled) {
      throw new ConflictError("该技能已停用");
    }
    return { name, content: skill.content };
  }

  revision(userId: string): number {
    return this.revisions.get(userId) ?? 0;
  }

  private write(userId: string, path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!inside(realpathSync(dirname(path)), this.root(userId))) {
      throw new ConflictError("技能文件必须位于自己的技能目录中");
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }

  setEnabled(userId: string, name: string, enabled: boolean): SkillSummary {
    this.get(userId, name);
    const activation = { ...this.activation(userId), [name]: enabled };
    this.write(
      userId,
      join(this.root(userId), "activation.json"),
      JSON.stringify(activation, null, 2) + "\n",
    );
    this.revisions.set(userId, this.revision(userId) + 1);
    return this.list(userId).find((skill) => skill.name === name)!;
  }

  save(userId: string, name: string, input: SkillWrite): SkillDetail {
    skillNameSchema.parse(name);
    const { content, enabled } = skillWriteSchema.parse(input);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(content);
    } catch {
      throw new AppError("INVALID_SKILL", "技能头部的 YAML 格式有误，请检查 name 和 description");
    }
    const { frontmatter, body } = parsed;
    const metadata = metadataSchema.parse(frontmatter);
    if (metadata.name !== name || !body.trim()) {
      throw new ConflictError("技能名必须与文件中的 name 一致，并填写操作说明");
    }
    this.write(userId, join(this.root(userId), name, "SKILL.md"), content);
    this.setEnabled(userId, name, enabled);
    return this.get(userId, name);
  }
}
