/**
 * Resolve and validate where /watch-trends should be copied.
 * Destination checks are pure so tests can cover them without writing disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = "watch-trends";
export const PRESERVED_DEST_FILES = ["config.public"];

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function resolveInstallDest({
  runtime,
  scope = "user",
  dest,
  cwd = process.cwd(),
  home = os.homedir(),
  workspace = process.env.OPENCLAW_WORKSPACE,
} = {}) {
  if (dest) return { ok: true, dest: path.resolve(cwd, dest) };

  const project = cwd;
  const key = `${runtime}:${scope}`;
  const map = {
    "claude:user": path.join(home, ".claude", "skills", SKILL_NAME),
    "claude:project": path.join(project, ".claude", "skills", SKILL_NAME),
    "cursor:user": path.join(home, ".cursor", "skills", SKILL_NAME),
    "cursor:project": path.join(project, ".cursor", "skills", SKILL_NAME),
    "codex:user": path.join(home, ".agents", "skills", SKILL_NAME),
    "codex:project": path.join(project, ".agents", "skills", SKILL_NAME),
    "hermes:user": path.join(home, ".hermes", "skills", SKILL_NAME),
    "hermes:project": path.join(project, ".hermes", "skills", SKILL_NAME),
    "agents:user": path.join(home, ".agents", "skills", SKILL_NAME),
    "agents:project": path.join(project, ".agents", "skills", SKILL_NAME),
  };

  if (runtime === "openclaw") {
    if (workspace) {
      return { ok: true, dest: path.join(path.resolve(workspace), "skills", SKILL_NAME) };
    }
    return { ok: false, code: "dest_required" };
  }

  const resolved = map[key];
  if (!resolved) return { ok: false, code: "usage" };
  return { ok: true, dest: resolved };
}

/**
 * Refuse dests that would overwrite a home, the filesystem root, a parent of
 * the source tree, or a subdirectory of the source (self-copy).
 */
export function validateInstallDest(dest, { skillRoot, home = os.homedir() } = {}) {
  if (!dest) {
    return { ok: false, code: "dest_required", message: "An install destination is required." };
  }

  const resolved = path.resolve(dest);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return {
      ok: false,
      code: "dest_refused",
      message: "Refusing to install onto the filesystem root.",
    };
  }
  if (home && path.resolve(home) === resolved) {
    return {
      ok: false,
      code: "dest_refused",
      message: "Refusing to install onto the home directory.",
    };
  }
  if (path.basename(resolved) !== SKILL_NAME) {
    return {
      ok: false,
      code: "dest_refused",
      message: `Destination must be a directory named ${SKILL_NAME}, not ${path.basename(resolved)}.`,
    };
  }

  if (skillRoot) {
    const source = path.resolve(skillRoot);
    if (resolved === source) {
      return { ok: true, dest: resolved, alreadyHere: true };
    }
    if (isInside(resolved, source)) {
      return {
        ok: false,
        code: "dest_inside_source",
        message: "Refusing to copy the skill into a subdirectory of itself.",
      };
    }
    if (isInside(source, resolved)) {
      return {
        ok: false,
        code: "dest_contains_source",
        message: "Refusing to install into a parent of the skill source tree.",
      };
    }
  }

  return { ok: true, dest: resolved, alreadyHere: false };
}

export function resolveAndValidateInstallDest(options) {
  const resolved = resolveInstallDest(options);
  if (!resolved.ok) return resolved;
  return validateInstallDest(resolved.dest, {
    skillRoot: options.skillRoot,
    home: options.home,
  });
}

export function invokeHint(runtime) {
  if (runtime === "codex") return "$watch-trends";
  if (runtime === "openclaw" || runtime === "hermes") return "/watch-trends or ask to watch a ticker";
  return "/watch-trends";
}

export function destErrorMessage(code) {
  switch (code) {
    case "dest_required":
      return {
        message:
          "OpenClaw needs --dest <workspace>/skills/watch-trends or OPENCLAW_WORKSPACE pointing at the workspace root.",
        next_action: "Pass --dest or set OPENCLAW_WORKSPACE, then rerun. See references/setup.md.",
      };
    case "dest_refused":
    case "dest_inside_source":
    case "dest_contains_source":
      return {
        message:
          "The install destination was refused. It must be a directory named watch-trends and must not be the filesystem root, your home directory, or a parent/child of the skill source.",
        next_action: "Use --runtime claude|cursor|codex|hermes or --dest /path/to/skills/watch-trends.",
      };
    default:
      return {
        message:
          "Usage: install-skill.mjs --runtime claude|cursor|codex|hermes|openclaw|agents [--scope user|project] [--dest PATH]",
        next_action: "Read references/setup.md and pick a destination for this runtime.",
      };
  }
}

function readPreserved(dest) {
  const preserved = [];
  for (const name of PRESERVED_DEST_FILES) {
    const file = path.join(dest, name);
    try {
      preserved.push({
        name,
        content: fs.readFileSync(file),
        mode: fs.statSync(file).mode,
      });
    } catch {
      /* dest does not have this local file yet */
    }
  }
  return preserved;
}

function restorePreserved(dest, preserved) {
  for (const file of preserved) {
    fs.writeFileSync(path.join(dest, file.name), file.content, { mode: file.mode & 0o777 });
  }
}

/**
 * Copy the skill tree, skipping node_modules/.git, and keep dest-local
 * config.public if one already exists.
 */
export function copySkillTree(from, to) {
  const preserved = readPreserved(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(from, src);
      if (!rel || rel === ".") return true;
      const parts = rel.split(path.sep);
      if (parts.includes("node_modules") || parts.includes(".git")) return false;
      if (preserved.length && parts.length === 1 && PRESERVED_DEST_FILES.includes(parts[0])) {
        return false;
      }
      return true;
    },
  });
  restorePreserved(to, preserved);
  return { preserved: preserved.map((f) => f.name) };
}
