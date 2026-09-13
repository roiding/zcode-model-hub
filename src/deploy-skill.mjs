// Deploy the user-space skill + command (layer 1: survives ZCode updates).
import fs from "node:fs";
import path from "node:path";
import { atomicWriteBuffer } from "../archive/verify.mjs";
import { home } from "../platform.mjs";

export function deploySkill() {
  const cliPath = fs.realpathSync(new URL("../../bin/zcode-model-hub.mjs", import.meta.url));
  const results = [];
  const jobs = [
    {
      template: "../../templates/skill-model-hub-SKILL.md",
      dest: path.join(home(), ".zcode", "skills", "model-hub", "SKILL.md"),
    },
    {
      template: "../../templates/command-pull-models.md",
      dest: path.join(home(), ".zcode", "commands", "pull-models.md"),
    },
  ];
  for (const job of jobs) {
    let txt = fs.readFileSync(new URL(job.template, import.meta.url), "utf8");
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
