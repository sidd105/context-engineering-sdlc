import type { Activity, ContextUnit, Diagnostic, Layer, Level, Relations, Scope } from "./types.js";
import { ACTIVITIES, KNOWN_KINDS, LAYERS, SCOPE_DIMENSIONS } from "./types.js";

const LEVELS: Level[] = ["must", "should", "may", "info"];
const RELATION_KEYS: (keyof Relations)[] = ["dependsOn", "refines", "overrides", "conflictsWith", "seeAlso"];
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

type Raw = Record<string, unknown>;

const strings = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * Validate and normalise one raw unit. Returns `unit: null` only for fatal
 * problems (missing id/layer/title); everything else is a warning with a
 * sensible default so a partially-written knowledge base still works.
 */
export function validateUnit(raw: Raw): { unit: ContextUnit | null; problems: Diagnostic[] } {
  const problems: Diagnostic[] = [];
  const id = typeof raw.id === "string" ? raw.id : "";
  const err = (message: string) => problems.push({ severity: "error", unitId: id || undefined, message });
  const warn = (message: string) => problems.push({ severity: "warning", unitId: id || undefined, message });

  if (!id) err("Unit is missing `id`");
  else if (!ID_RE.test(id)) err(`Invalid id "${id}" (use lowercase letters, digits, '.', '_' or '-')`);

  const layer = raw.layer as Layer;
  if (!LAYERS.includes(layer)) err(`Invalid or missing layer "${String(raw.layer)}" (expected one of ${LAYERS.join(", ")})`);

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) err("Unit is missing `title`");

  if (problems.some((p) => p.severity === "error")) return { unit: null, problems };

  const kind = String(raw.kind ?? "info");
  if (!(KNOWN_KINDS as readonly string[]).includes(kind)) warn(`Unknown kind "${kind}" (allowed, but the engine won't give it activity boosts)`);

  let level = (raw.level ?? "should") as Level;
  if (!LEVELS.includes(level)) {
    warn(`Invalid level "${String(raw.level)}", defaulting to "should"`);
    level = "should";
  }

  const scope: Scope = {};
  const rawScope = (raw.scope ?? {}) as Raw;
  for (const key of Object.keys(rawScope)) {
    if (!(SCOPE_DIMENSIONS as readonly string[]).includes(key)) warn(`Unknown scope dimension "${key}"`);
  }
  for (const dim of SCOPE_DIMENSIONS) {
    const vals = strings(rawScope[dim]);
    if (vals.length) scope[dim] = vals;
  }

  const relations: Relations = {};
  const rawRel = (raw.relations ?? {}) as Raw;
  for (const key of RELATION_KEYS) {
    const vals = strings(rawRel[key]);
    if (vals.length) relations[key] = vals;
  }

  let activities: Activity[] | undefined;
  if (raw.activities != null) {
    activities = strings(raw.activities).filter((a): a is Activity => {
      const ok = (ACTIVITIES as readonly string[]).includes(a);
      if (!ok) warn(`Unknown activity "${a}"`);
      return ok;
    });
  }

  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body && kind !== "term") warn("Unit has no `body`; only the title will be available");

  const unit: ContextUnit = {
    id,
    layer,
    kind,
    title,
    body,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : undefined,
    level,
    scope,
    tags: [...new Set(strings(raw.tags))],
    aliases: raw.aliases ? strings(raw.aliases) : undefined,
    activities,
    pinned: raw.pinned === true,
    relations,
    owner: raw.owner as string | undefined,
    source: raw.source as string | undefined,
    reviewed: raw.reviewed != null ? String(raw.reviewed instanceof Date ? raw.reviewed.toISOString().slice(0, 10) : raw.reviewed) : undefined,
  };
  return { unit, problems };
}
