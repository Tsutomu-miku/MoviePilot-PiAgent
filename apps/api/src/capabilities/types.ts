import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { StateStore } from "../core/store.js";
import type { SearchService } from "../services/search-service.js";
import type { TaskService } from "../services/task-service.js";
import type { MediaBackend } from "../integrations/moviepilot.js";

export interface ToolServices {
  store: StateStore;
  search: SearchService;
  tasks: TaskService;
  backend: MediaBackend;
  loader: DefaultResourceLoader;
  skillsDir: string;
}
