import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { resolveProfiles } from "../engine/activity.js";
import type { ContextUnit, Diagnostic, KnowledgeBase, Manifest, ServiceInfo } from "../model/types.js";
import { validateUnit } from "../model/validate.js";

export const MANIFEST_FILE = "context.yaml";

type Raw = Record<string, unknown>;

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

export function listYaml(path: string): string[] {
  if (!existsSync(path)) return [];
  const st = statSync(path);
  if (st.isFile()) return /\.ya?ml$/.test(path) ? [path] : [];
  const out: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    out.push(...listYaml(join(path, entry)));
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

export function parseManifest(raw: Raw, dir: string): Manifest {
  const topo = (raw.topology ?? {}) as Raw;
  const services: Record<string, ServiceInfo> = {};
  // topology.domains.<domain>.services.<service>: { team, repo, aliases }
  const domains = (topo.domains ?? {}) as Record<string, Raw>;
  for (const [domain, d] of Object.entries(domains)) {
    const svcs = (d?.services ?? {}) as Record<string, Raw | null>;
    for (const [name, s] of Object.entries(svcs)) {
      services[name] = {
        domain,
        team: (s?.team as string) ?? (d.team as string | undefined),
        repo: s?.repo as string | undefined,
        businessUnit: (s?.businessUnit as string) ?? (d.businessUnit as string | undefined),
        aliases: asStringArray(s?.aliases),
      };
    }
  }
  return {
    organization: String(raw.organization ?? basename(dir)),
    description: raw.description as string | undefined,
    extends: asStringArray(raw.extends),
    include: raw.include ? asStringArray(raw.include) : ["."],
    topology: { services, environments: asStringArray(topo.environments) },
    activities: (raw.activities ?? {}) as Manifest["activities"],
    staleAfterDays: Number(raw.staleAfterDays ?? 365),
  };
}

interface LoadState {
  units: Map<string, ContextUnit>;
  diagnostics: Diagnostic[];
  visited: Set<string>;
}

function loadPack(dir: string, state: LoadState, root: string): Manifest {
  const abs = resolve(dir);
  const manifestPath = join(abs, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`No ${MANIFEST_FILE} found in ${abs}`);
  const manifest = parseManifest((readYaml(manifestPath) ?? {}) as Raw, abs);
  if (state.visited.has(abs)) return manifest;
  state.visited.add(abs);

  // Parent packs load first so this pack can override their units by id.
  for (const parent of manifest.extends) loadPack(resolve(abs, parent), state, root);

  const packName = manifest.organization;
  const files = manifest.include.flatMap((inc) => listYaml(resolve(abs, inc))).filter((f) => basename(f) !== MANIFEST_FILE);
  for (const file of new Set(files)) {
    const rel = relative(root, file);
    let doc: Raw;
    try {
      doc = (readYaml(file) ?? {}) as Raw;
    } catch (e) {
      state.diagnostics.push({ severity: "error", file: rel, message: `YAML parse error: ${(e as Error).message}` });
      continue;
    }
    const defaults = (doc.defaults ?? {}) as Raw;
    const rawUnits = (doc.units ?? []) as Raw[];
    if (!Array.isArray(rawUnits)) {
      state.diagnostics.push({ severity: "error", file: rel, message: "`units` must be a list" });
      continue;
    }
    for (const ru of rawUnits) {
      const merged: Raw = {
        ...defaults,
        ...ru,
        scope: { ...((defaults.scope as Raw) ?? {}), ...((ru.scope as Raw) ?? {}) },
        tags: [...asStringArray(defaults.tags), ...asStringArray(ru.tags)],
      };
      const { unit, problems } = validateUnit(merged);
      for (const p of problems) state.diagnostics.push({ ...p, file: rel });
      if (!unit) continue;
      unit.pack = packName;
      unit.file = rel;
      const existing = state.units.get(unit.id);
      if (existing && existing.pack === packName) {
        state.diagnostics.push({ severity: "error", unitId: unit.id, file: rel, message: `Duplicate id (also in ${existing.file})` });
      }
      state.units.set(unit.id, unit);
    }
  }
  return manifest;
}

/** Load a pack directory (and everything it extends) into a knowledge base. */
export function loadKnowledgeBase(dir: string): KnowledgeBase {
  const root = resolve(dir);
  const state: LoadState = { units: new Map(), diagnostics: [], visited: new Set() };
  const manifest = loadPack(root, state, dirname(root));
  checkReferences(state.units, state.diagnostics);
  return {
    manifest,
    units: state.units,
    profiles: resolveProfiles(manifest.activities),
    diagnostics: state.diagnostics,
    roots: [...state.visited],
  };
}

function checkReferences(units: Map<string, ContextUnit>, diagnostics: Diagnostic[]): void {
  for (const u of units.values()) {
    for (const [rel, ids] of Object.entries(u.relations)) {
      for (const id of ids ?? []) {
        if (!units.has(id)) {
          diagnostics.push({ severity: "warning", unitId: u.id, file: u.file, message: `${rel} references unknown unit "${id}"` });
        }
      }
    }
  }
}

/**
 * Decide which knowledge base to load: an explicit path, then $CTX_KB, then the
 * current directory if it has a context.yaml, then `fallback` (if given).
 */
export function findKnowledgeBase(explicit?: string, fallback?: string): string {
  const candidates = [explicit, process.env.CTX_KB];
  for (const c of candidates) if (c) return resolve(c);
  if (existsSync(join(process.cwd(), MANIFEST_FILE))) return process.cwd();
  if (fallback && existsSync(join(fallback, MANIFEST_FILE))) return fallback;
  throw new Error(`No knowledge base found. Pass --kb <dir>, set CTX_KB, or run from a folder that contains ${MANIFEST_FILE}.`);
}
