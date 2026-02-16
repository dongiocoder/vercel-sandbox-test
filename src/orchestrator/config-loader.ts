import * as fs from "fs";
import * as path from "path";
import type { AgentConfigBundle } from "./types.js";

const CONFIGS_DIR = path.join(process.cwd(), "agent-configs");

/**
 * Load agent configuration bundle from agent-configs/{agentId}/ directory.
 *
 * Expected structure:
 *   agent-configs/{agentId}/
 *     CLAUDE.md
 *     agent-config.json
 *     .claude/skills/...  (optional)
 */
export function loadAgentConfig(agentId: string): AgentConfigBundle {
  const agentDir = path.join(CONFIGS_DIR, agentId);

  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent config directory not found: ${agentDir}`);
  }

  // Load CLAUDE.md
  const claudeMdPath = path.join(agentDir, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found for agent: ${agentId}`);
  }
  const claudeMd = fs.readFileSync(claudeMdPath, "utf-8");

  // Load agent-config.json
  const configPath = path.join(agentDir, "agent-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`agent-config.json not found for agent: ${agentId}`);
  }
  const agentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Load skill files recursively from .claude/skills/
  const skills: Record<string, string> = {};
  const skillsDir = path.join(agentDir, ".claude", "skills");

  if (fs.existsSync(skillsDir)) {
    loadSkillsRecursive(skillsDir, skillsDir, skills);
  }

  return { claudeMd, agentConfig, skills };
}

function loadSkillsRecursive(
  baseDir: string,
  currentDir: string,
  skills: Record<string, string>
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      loadSkillsRecursive(baseDir, fullPath, skills);
    } else if (entry.isFile()) {
      skills[relativePath] = fs.readFileSync(fullPath, "utf-8");
    }
  }
}

/**
 * List available agent IDs (directory names under agent-configs/).
 */
export function listAgentIds(): string[] {
  if (!fs.existsSync(CONFIGS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(CONFIGS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
