import type { StateStore } from "../core/store.js";
import type { SearchService } from "../services/search-service.js";
import type { TaskService } from "../services/task-service.js";
import type { MediaBackend } from "../integrations/moviepilot.js";
import type { TransferService } from "../services/transfer-service.js";
import type { SkillService } from "../services/skill-service.js";
import type { MikanSearchService } from "../services/mikan-search-service.js";

export interface ToolServices {
  store: StateStore;
  search: SearchService;
  tasks: TaskService;
  transfers: TransferService;
  backend: MediaBackend;
  skills: SkillService;
  mikan: MikanSearchService;
}
