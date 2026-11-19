/** Picks the stage implementations. Add new ones here (e.g. a cheaper researcher) without touching the pipeline. */
import { config } from "../config.js";
import type { Stages } from "../types.js";
import { claudeStages } from "./claude.js";
import { offlineStages } from "./offline.js";

export const stages: Stages = config.offline ? offlineStages : claudeStages;
