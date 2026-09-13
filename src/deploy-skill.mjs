// Deploy the user-space skill + command (layer 1: survives ZCode updates).
// NOTE: this file lives in src/, so project-root assets are ONE level up
// (../bin, ../templates) — an earlier ../../ version shipped broken.
import fs from "node:fs";
import path from "node:path";
import { atomicWriteBuffer } from "./archive/verify.mjs";
import { home } from "./platform.mjs";

// Resolvable asset descriptors, exported for tests.
export function skillAssets() {
  return [
    {
      cli: new URL("../bin/zcode-model-hub.mjs", import.meta.url),
      template: new URL("../templates/skill-model-hub-SKILL.md", import.meta.url),
      dest: path.join(home(), ".zcode", "skills", "model-hub", "SKILL.md"),
    },
    {
      cli: new URL("../bin/zcode-model-hub.mjs", import.meta.url),
      template: new URL("../templates/command-pull-models.md", import.meta.url),
      dest: path.join(home(), ".zcode", "commands", "pull-models.md"),
    },
  ];
}

export function deploySkill() {
  const cliPath = fs.realpathSync(skillAssets()[0].cli);
  const results = [];
  for (const job of skillAssets()) {
    let txt = fs.readFileSync(job.template, "utf8");
    txt = txt.split("{{CLI_PATH}}").join(cliPath);
    fs.mkdirSync(path.dirname(job.dest), { recursive: true });
    atomicWriteBuffer(job.dest, Buffer.from(txt, "utf8"));
    results.push(job.dest);
  }
  return results;
}

export function removeSkill() {
  const removed = [];
  const targets = [
    path.join(home(), ".zcode", "skills", "model-hub"),
    path.join(home(), ".zcode", "commands", "pull-models.md"),
  ];
  for (const t of targets) {
    fs.rmSync(t, { recursive: true, force: true });
    removed.push(t);
  }
  return removed;
}
