#!/usr/bin/env node
/** Fail on added private-key headers or literal administrator-secret assignments. */
let patch = "";
for await (const chunk of process.stdin) patch += chunk;

let path = "";
let lineNumber = 0;
const findings = [];
for (const line of patch.split("\n")) {
  if (line.startsWith("+++ b/")) {
    path = line.slice(6).trim();
    lineNumber = 0;
    continue;
  }
  if (line.startsWith("@@")) {
    const match = line.match(/\+(\d+)/);
    lineNumber = match ? Number(match[1]) - 1 : 0;
    continue;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    lineNumber++;
    const added = line.slice(1);
    if (/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(added)) {
      findings.push({ path, lineNumber, kind: "private key header" });
      continue;
    }
    const assignment = added.match(/(?:\b(?:AWARD_SECRET|RESET_SECRET)\s*=\s*|^\s*(?:AWARD_SECRET|RESET_SECRET)\s*:\s*|(?<!\$)[{,]\s*(?:AWARD_SECRET|RESET_SECRET)\s*:\s*)/i);
    if (!assignment) continue;
    const value = added.slice((assignment.index || 0) + assignment[0].length).trim();
    if (/^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/i.test(value)) continue;
    const quote = value[0];
    const end = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    const literal = end > 0 ? value.slice(1, end) : "";
    if (path.startsWith("tests/") && /^(test|local)-/i.test(literal)) continue;
    findings.push({ path, lineNumber, kind: "literal administrator secret" });
  } else if (!line.startsWith("-")) {
    lineNumber++;
  }
}

if (findings.length) {
  for (const finding of findings) console.error(`Possible ${finding.kind} at ${finding.path || "unknown"}:${finding.lineNumber || "?"}.`);
  process.exit(1);
}
console.log("Supplemental secret diff scan passed.");
