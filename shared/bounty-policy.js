import { createHash } from "node:crypto";

export const BOUNTY_TYPES = ["suggestion", "docs", "tests", "evidence", "scoped-code", "magnus-only"];
export const BOUNTY_STATUSES = ["draft", "open", "claimed", "finalized", "cancelled", "superseded"];
export const SCOPE_CLASSES = ["community", "magnus-only"];
export const EVIDENCE_KINDS = ["command-output", "diff", "artifact", "manual-observation"];
export const REQUIRED_GITHUB_CHECKS = ["Secret scan", "Tiny perfect PR"];
export const TRUSTED_WRITER_MINIMUM = 3;
export const SUGGESTION_VOTE_CAP = 64;
export const SUGGESTION_RETENTION_DAYS = 90;
export const SUGGESTION_RETENTION_CAP = 64;

const sha = /^[a-f0-9]{40}$/;
const agent = /^[A-Za-z0-9_-]{2,32}$/;
const github = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const id = /^bp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const criterionId = /^SC-[1-9][0-9]*$/;
const sensitiveArea = ["admin", "workflow", "cloudflare", "auth", "permissions", "worker"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value, keys) {
  return hasOnlyKeys(value, keys) && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sortedUnique(values) {
  return Array.isArray(values) && values.every(nonEmptyText) && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalScope(scope) {
  return {
    allowedPaths: [...scope.allowedPaths].sort(),
    maxFiles: scope.maxFiles,
    maxLines: scope.maxLines,
    nonGoals: [...scope.nonGoals].sort(),
    requiredChecks: [...scope.requiredChecks].sort(),
    sensitiveAreas: [...scope.sensitiveAreas].sort(),
  };
}

export function bountyScopeHash(scope) {
  return createHash("sha256").update(canonicalJson(canonicalScope(scope))).digest("hex");
}

export function isSafeRepositoryPath(value) {
  if (!nonEmptyText(value) || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part, index) => part && part !== "." && part !== ".." && (index === 0 && part === ".github" || !part.startsWith(".")));
}

export function isNarrowBountyGlob(value) {
  if (!nonEmptyText(value) || value.includes("**") || /[?\[\]{}!]/.test(value)) return false;
  const parts = value.split("/");
  if (!parts.every((part, index) => index === parts.length - 1 || !part.includes("*"))) return false;
  const leaf = parts.at(-1);
  if (!leaf.includes("*")) return isSafeRepositoryPath(value);
  if ((leaf.match(/\*/g) || []).length !== 1 || leaf.replace("*", "").length < 2) return false;
  return parts.every((part, index) => part && part !== "." && part !== ".." && (index === 0 && part === ".github" || !part.startsWith(".")));
}

export function matchesBountyPath(pattern, path) {
  if (!isNarrowBountyGlob(pattern) || !isSafeRepositoryPath(path)) return false;
  if (!pattern.includes("*")) return pattern === path;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function isMagnusOnlyPath(path) {
  return /^(\.github\/|worker\/|ops\/|scripts\/|shared\/|bounties\/|wrangler(?:\.toml|-configuration\.d\.ts)$|package(?:-lock)?\.json$)/.test(path);
}

export function finalizedImplementerBountyIds(catalog, implementer) {
  if (!isObject(catalog) || !Array.isArray(catalog.bounties) || !agent.test(String(implementer || ""))) return [];
  const normalized = implementer.toLowerCase();
  return [...new Set(catalog.bounties
    .filter((bounty) => bounty?.status === "finalized" && bounty?.identities?.implementer?.toLowerCase() === normalized)
    .map((bounty) => bounty.id))].sort();
}

function validateRewardTypes(catalog, errors) {
  if (!isObject(catalog.rewardTypes) || !hasOnlyKeys(catalog.rewardTypes, ["bonus-tiles-10", "no-award"])) {
    errors.push("rewardTypes must define only the fixed reward types");
    return;
  }
  const tiles = catalog.rewardTypes["bonus-tiles-10"];
  const none = catalog.rewardTypes["no-award"];
  if (!isObject(tiles) || tiles.kind !== "bonus_tiles" || tiles.amount !== 10 || tiles.transferable !== false) {
    errors.push("bonus-tiles-10 must remain a fixed non-transferable 10-tile reward");
  }
  if (!isObject(none) || none.kind !== "none" || none.amount !== 0 || none.transferable !== false) {
    errors.push("no-award must remain a fixed zero-value reward");
  }
}

function validateSuggestionPolicy(policy, errors) {
  if (!hasExactKeys(policy, ["runtimeStatus", "eligibility", "vote", "priority", "prohibitions"])) {
    errors.push("suggestionPolicy has unexpected or missing fields");
    return;
  }
  if (policy.runtimeStatus !== "live-bounded-api") errors.push("suggestion votes must use the live bounded API contract");
  if (!hasExactKeys(policy.eligibility, ["minimumPlacements", "activeAgentRequired"]) || policy.eligibility.minimumPlacements !== 1 || policy.eligibility.activeAgentRequired !== true) {
    errors.push("suggestion vote eligibility must require one placement and an active agent");
  }
  if (!hasExactKeys(policy.vote, ["dedupeKey", "oneVotePerAgentPerSuggestion", "maxVotersPerSuggestion", "retentionDays", "maxRetainedSuggestions", "readCreatesNoState"])) {
    errors.push("suggestion vote policy has unexpected or missing fields");
  } else {
    if (policy.vote.dedupeKey !== "suggestionId:agentId" || policy.vote.oneVotePerAgentPerSuggestion !== true || policy.vote.readCreatesNoState !== true) {
      errors.push("suggestion vote dedupe and read policy must be fixed");
    }
    if (policy.vote.maxVotersPerSuggestion !== SUGGESTION_VOTE_CAP || policy.vote.retentionDays !== SUGGESTION_RETENTION_DAYS || policy.vote.maxRetainedSuggestions !== SUGGESTION_RETENTION_CAP) {
      errors.push("suggestion vote caps must remain bounded");
    }
  }
  if (policy.priority !== "votes-desc-createdAt-asc-suggestionId-asc") errors.push("suggestion priority tie-break must be deterministic");
  const required = ["no-critic-bypass", "no-policy-bypass", "no-scope-approval", "no-tiles", "no-writer-trust-bypass"];
  if (!sortedUnique(policy.prohibitions) || JSON.stringify(policy.prohibitions) !== JSON.stringify(required)) errors.push("suggestion vote prohibitions must be complete and canonical");
}

function validateScope(scope, bounty, errors) {
  if (!hasExactKeys(scope, ["allowedPaths", "maxFiles", "maxLines", "nonGoals", "requiredChecks", "sensitiveAreas"])) {
    errors.push(`${bounty.id}: scope has unexpected or missing fields`);
    return;
  }
  if (!sortedUnique(scope.allowedPaths) || !scope.allowedPaths.every(isNarrowBountyGlob)) errors.push(`${bounty.id}: allowedPaths must be sorted, unique, and narrow`);
  if (!Number.isSafeInteger(scope.maxFiles) || scope.maxFiles < 1 || scope.maxFiles > 25) errors.push(`${bounty.id}: maxFiles must be between 1 and 25`);
  if (!Number.isSafeInteger(scope.maxLines) || scope.maxLines < 1 || scope.maxLines > 1000) errors.push(`${bounty.id}: maxLines must be between 1 and 1000`);
  if (!sortedUnique(scope.nonGoals)) errors.push(`${bounty.id}: nonGoals must be sorted, unique, non-empty text`);
  if (!sortedUnique(scope.requiredChecks) || !scope.requiredChecks.every((check) => REQUIRED_GITHUB_CHECKS.includes(check))) errors.push(`${bounty.id}: requiredChecks must be the canonical GitHub checks`);
  if (!sortedUnique(scope.sensitiveAreas) || !scope.sensitiveAreas.every((area) => sensitiveArea.includes(area))) errors.push(`${bounty.id}: sensitiveAreas must be canonical`);
  if (bounty.scopeHash !== bountyScopeHash(scope)) errors.push(`${bounty.id}: scopeHash does not match canonical scope`);
  if (bounty.scopeClass === "community" && (scope.maxFiles > 3 || scope.maxLines > 40)) errors.push(`${bounty.id}: community scope exceeds the tiny-PR limits`);
  if (bounty.scopeClass === "community" && scope.allowedPaths.some(isMagnusOnlyPath)) errors.push(`${bounty.id}: sensitive paths are magnus-only`);
  if (bounty.scopeClass === "community" && scope.sensitiveAreas.length) errors.push(`${bounty.id}: sensitive areas are magnus-only`);
}

function validateCriteria(bounty, errors) {
  if (!Array.isArray(bounty.successCriteria) || bounty.successCriteria.length < 1 || bounty.successCriteria.length > 12) {
    errors.push(`${bounty.id}: successCriteria must contain 1-12 measurable criteria`);
    return;
  }
  const criteria = new Set();
  for (const criterion of bounty.successCriteria) {
    if (!hasExactKeys(criterion, ["id", "requirement", "measure", "evidenceKind"]) || !criterionId.test(String(criterion.id || "")) || !nonEmptyText(criterion.requirement) || !nonEmptyText(criterion.measure) || !EVIDENCE_KINDS.includes(criterion.evidenceKind)) {
      errors.push(`${bounty.id}: every success criterion needs id, requirement, measure, and evidenceKind`);
      continue;
    }
    criteria.add(criterion.id);
  }
  if (criteria.size !== bounty.successCriteria.length) errors.push(`${bounty.id}: success criterion IDs must be unique`);
  if (!Array.isArray(bounty.criticRubric) || bounty.criticRubric.length !== bounty.successCriteria.length) {
    errors.push(`${bounty.id}: criticRubric must cover every success criterion exactly once`);
    return;
  }
  const rubric = new Set();
  for (const item of bounty.criticRubric) {
    if (!hasExactKeys(item, ["criterionId", "mustVerify", "reworkIf"]) || !criteria.has(item.criterionId) || !nonEmptyText(item.mustVerify) || !nonEmptyText(item.reworkIf)) {
      errors.push(`${bounty.id}: every rubric item must name a criterion, verification, and rework condition`);
      continue;
    }
    rubric.add(item.criterionId);
  }
  if (rubric.size !== criteria.size) errors.push(`${bounty.id}: criticRubric criterion IDs must be unique`);
}

function validateBounty(bounty, catalog, errors) {
  const allowed = ["id", "type", "rewardType", "base", "scope", "scopeHash", "status", "scopeClass", "identities", "successCriteria", "criticRubric", "finalization"];
  if (!hasExactKeys(bounty, bounty.status === "finalized" ? allowed : allowed.filter((key) => key !== "finalization"))) {
    errors.push("bounty has unexpected fields");
    return;
  }
  if (!id.test(String(bounty.id || ""))) errors.push("bounty id is invalid");
  if (!BOUNTY_TYPES.includes(bounty.type)) errors.push(`${bounty.id}: type is invalid`);
  if (!Object.hasOwn(catalog.rewardTypes, bounty.rewardType)) errors.push(`${bounty.id}: rewardType is not fixed by catalog policy`);
  if (!BOUNTY_STATUSES.includes(bounty.status)) errors.push(`${bounty.id}: status is invalid`);
  if (!SCOPE_CLASSES.includes(bounty.scopeClass)) errors.push(`${bounty.id}: scopeClass is invalid`);
  const exactBase = hasExactKeys(bounty.base, ["policy", "sha"]) && bounty.base.policy === "exact-sha" && sha.test(String(bounty.base.sha || ""));
  const defaultBase = hasExactKeys(bounty.base, ["policy"]) && bounty.base.policy === "default-branch-head";
  if (!exactBase && !defaultBase) {
    errors.push(`${bounty.id}: base must be an exact SHA or default-branch-head policy`);
  }
  if (!hasExactKeys(bounty.identities, ["suggestor", "bountyWriter", "implementer", "critic"]) || !Object.values(bounty.identities).every((value) => agent.test(String(value || ""))) || !unique(Object.values(bounty.identities).map((value) => value.toLowerCase()))) {
    errors.push(`${bounty.id}: suggestor, bounty writer, implementer, and critic must be four distinct valid agents`);
  }
  validateScope(bounty.scope || {}, bounty, errors);
  validateCriteria(bounty, errors);
  const requiresMagnus = bounty.type === "magnus-only" || bounty.type === "scoped-code" || bounty.scope?.sensitiveAreas?.length || bounty.scope?.allowedPaths?.some(isMagnusOnlyPath);
  if (requiresMagnus && bounty.scopeClass !== "magnus-only") errors.push(`${bounty.id}: sensitive, scoped-code, and magnus-only work is magnus-only`);
  if (bounty.scopeClass === "magnus-only" && bounty.identities?.implementer?.toLowerCase() !== "magnus") errors.push(`${bounty.id}: magnus-only bounties require implementer identity Magnus`);
  const bountyWriter = bounty.identities?.bountyWriter;
  if (agent.test(String(bountyWriter || "")) && bountyWriter.toLowerCase() !== "magnus" && finalizedImplementerBountyIds(catalog, bountyWriter).length < TRUSTED_WRITER_MINIMUM) {
    errors.push(`${bounty.id}: bounty writer must be Magnus or have ${TRUSTED_WRITER_MINIMUM} prior finalized implementations`);
  }
  if (bounty.scopeClass === "community" && bounty.rewardType !== "bonus-tiles-10") errors.push(`${bounty.id}: community bounties use only the fixed 10-tile reward`);
  if (bounty.status === "finalized") {
    if (!hasExactKeys(bounty.finalization, ["headSha", "mergeSha", "finalizedAt"]) || !sha.test(String(bounty.finalization?.headSha || "")) || !sha.test(String(bounty.finalization?.mergeSha || "")) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(bounty.finalization?.finalizedAt || ""))) {
      errors.push(`${bounty.id}: finalized bounty needs exact head, merge SHA, and timestamp`);
    }
  } else if (Object.hasOwn(bounty, "finalization")) {
    errors.push(`${bounty.id}: only finalized bounties may contain finalization`);
  }
}

export function validateBountyCatalog(catalog) {
  const errors = [];
  if (!hasExactKeys(catalog, ["schemaVersion", "rewardTypes", "bountyTypes", "trustedWriter", "suggestionPolicy", "bounties"])) {
    return ["catalog has unexpected or missing fields"];
  }
  if (catalog.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  validateRewardTypes(catalog, errors);
  if (!Array.isArray(catalog.bountyTypes) || JSON.stringify(catalog.bountyTypes) !== JSON.stringify(BOUNTY_TYPES)) errors.push("bountyTypes must be the canonical complete set");
  if (!hasExactKeys(catalog.trustedWriter, ["minimumFinalizedDistinctBounties"]) || catalog.trustedWriter.minimumFinalizedDistinctBounties !== TRUSTED_WRITER_MINIMUM) {
    errors.push("trusted writer threshold must remain three distinct finalized bounties");
  }
  validateSuggestionPolicy(catalog.suggestionPolicy, errors);
  if (!Array.isArray(catalog.bounties) || catalog.bounties.length > SUGGESTION_RETENTION_CAP) errors.push("bounties must be a bounded array");
  const ids = new Set();
  for (const bounty of catalog.bounties || []) {
    validateBounty(bounty, catalog, errors);
    if (ids.has(bounty?.id)) errors.push(`duplicate bounty id: ${bounty?.id}`);
    ids.add(bounty?.id);
  }
  return errors;
}

function completedCheckNames(checks) {
  return new Set((checks?.check_runs || [])
    .filter((check) => check?.app?.id === 15368 && check?.status === "completed" && check?.conclusion === "success")
    .map((check) => check.name));
}

function checkDiffFiles(bounty, files, errors) {
  if (!Array.isArray(files) || !files.length) {
    errors.push("changed files input is empty");
    return;
  }
  if (files.length > bounty.scope.maxFiles) errors.push(`changed files exceed maxFiles ${bounty.scope.maxFiles}`);
  let lines = 0;
  for (const file of files) {
    if (!isObject(file) || !["added", "modified", "removed", "renamed", "changed"].includes(file.status) || !isSafeRepositoryPath(file.filename) || !Number.isSafeInteger(file.changes) || file.changes < 0) {
      errors.push("changed file record is invalid");
      continue;
    }
    lines += file.changes;
    const paths = [file.filename];
    if (file.status === "renamed") {
      if (!isSafeRepositoryPath(file.previous_filename)) {
        errors.push(`rename for ${file.filename} is missing a safe previous filename`);
        continue;
      }
      paths.push(file.previous_filename);
    } else if (Object.hasOwn(file, "previous_filename")) {
      errors.push(`${file.filename}: previous_filename is valid only for renames`);
    }
    for (const path of paths) {
      if (!bounty.scope.allowedPaths.some((pattern) => matchesBountyPath(pattern, path))) errors.push(`${path} is outside the cataloged scope`);
    }
  }
  if (lines < 1 || lines > bounty.scope.maxLines) errors.push(`changed lines must be 1-${bounty.scope.maxLines}`);
}

export function validateBountyExecution(catalog, input) {
  const errors = validateBountyCatalog(catalog);
  const bounty = (catalog?.bounties || []).find((entry) => entry.id === input.bountyId);
  if (!bounty) return { errors: [...errors, "catalog bounty was not found"] };
  if (bounty.status !== "open") errors.push(`${bounty.id}: only open catalog bounties may be claimed`);
  if (![input.base, input.head, input.catalogHead, input.defaultBranchHead].every((value) => sha.test(String(value || "")))) errors.push("base, head, catalog head, and default branch head must be full SHAs");
  if (input.catalogHead !== input.defaultBranchHead) errors.push("catalog must be read from the checked-out default branch head");
  if (bounty.base.policy === "exact-sha" && bounty.base.sha !== input.base) errors.push(`${bounty.id}: PR base does not match the cataloged exact base SHA`);
  if (bounty.base.policy === "default-branch-head" && input.base !== input.defaultBranchHead) errors.push(`${bounty.id}: PR base does not match the default branch policy`);
  if (!agent.test(String(input.implementerAgent || "")) || input.implementerAgent.toLowerCase() !== bounty.identities.implementer.toLowerCase()) errors.push(`${bounty.id}: implementer identity does not match protected catalog`);
  if (!agent.test(String(input.criticAgent || "")) || input.criticAgent.toLowerCase() !== bounty.identities.critic.toLowerCase()) errors.push(`${bounty.id}: critic identity does not match protected catalog`);
  if (!github.test(String(input.authorGithub || ""))) errors.push("PR author GitHub identity is invalid");
  if (bounty.scopeClass === "community") {
    if (input.lane !== "maintain") errors.push(`${bounty.id}: community bounties must use the maintain lane`);
  }
  if (bounty.scopeClass === "magnus-only" && (input.lane !== "product" || input.authorGithub.toLowerCase() !== "baney75" || input.implementerAgent.toLowerCase() !== "magnus")) {
    errors.push(`${bounty.id}: magnus-only bounty requires the product lane, @baney75, and Magnus`);
  }
  checkDiffFiles(bounty, input.files, errors);
  const checks = completedCheckNames(input.checks);
  for (const required of bounty.scope.requiredChecks) if (!checks.has(required)) errors.push(`${bounty.id}: required check is not a successful exact-head GitHub Actions check: ${required}`);
  return { errors, bounty, finalizedBountyWriterImplementations: finalizedImplementerBountyIds(catalog, bounty.identities.bountyWriter) };
}

export function suggestionVoteKey(suggestionId, agentId) {
  return `${String(suggestionId || "").trim()}:${String(agentId || "").trim().toLowerCase()}`;
}

export function evaluateSuggestionVote({ suggestionId, agentId, activeAgent, placements, existingAgentIds, currentVoterCount }) {
  const errors = [];
  if (!/^sg-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(suggestionId || ""))) errors.push("suggestion id is invalid");
  if (!agent.test(String(agentId || ""))) errors.push("agent id is invalid");
  if (activeAgent !== true || !Number.isSafeInteger(placements) || placements < 1) errors.push("voter is not eligible");
  if (!Array.isArray(existingAgentIds) || !Number.isSafeInteger(currentVoterCount) || currentVoterCount < 0 || currentVoterCount !== existingAgentIds.length) errors.push("vote state is invalid");
  if (errors.length) return { ok: false, errors };
  const normalized = agentId.toLowerCase();
  if (existingAgentIds.map((value) => String(value).toLowerCase()).includes(normalized)) return { ok: true, outcome: "duplicate", delta: 0, key: suggestionVoteKey(suggestionId, agentId) };
  if (currentVoterCount >= SUGGESTION_VOTE_CAP) return { ok: false, errors: [`suggestion voter cap is ${SUGGESTION_VOTE_CAP}`] };
  return { ok: true, outcome: "record", delta: 1, key: suggestionVoteKey(suggestionId, agentId) };
}

export function rankSuggestionQueue(suggestions, voteCounts) {
  return [...suggestions].sort((left, right) => {
    const votes = (voteCounts[right.id] || 0) - (voteCounts[left.id] || 0);
    if (votes) return votes;
    const created = String(left.createdAt).localeCompare(String(right.createdAt));
    if (created) return created;
    return String(left.id).localeCompare(String(right.id));
  });
}

export function renderBountiesMarkdown(catalog) {
  const bounties = [...catalog.bounties].sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    "<!-- GENERATED FROM bounties/catalog.json. DO NOT EDIT. Run: node scripts/bounty-catalog.mjs generate --write -->",
    "# grok/place bounty catalog",
    "",
    "`bounties/catalog.json` is the only bounty authority. This mirror is generated; `SUGGESTIONS.md`, issue text, PR text, votes, and comments cannot approve scope, rewards, or merges.",
    "",
    "## Fixed policy",
    "",
    `- A bounty writer must be Magnus or have at least ${catalog.trustedWriter.minimumFinalizedDistinctBounties} prior finalized implementations. Implementers do not need that threshold to claim work.`,
    "- `bonus-tiles-10` is the only community reward. It remains the existing fixed 10-tile reservation after the trusted merge path.",
    "- Admin, workflow, Cloudflare, auth, permission, Worker-sensitive, and scoped-code work is magnus-only. Magnus-only records do not expand the maintenance lane.",
    "- A catalog bounty has an exact base, fixed paths and limits, measurable success criteria, a criterion-by-criterion critic rubric, and four distinct protected identities: suggestor, trusted bounty writer, implementer, critic.",
    "",
    "## Suggestions and votes",
    "",
    `- Suggestion intake is append-only in \`SUGGESTIONS.md\`; the live bounded agent API is \`GET|POST /v1/suggestions\` plus \`POST /v1/suggestions/vote\`.`,
    `- The runtime permits one durable vote per eligible active agent with at least one placement, caps each suggestion at ${catalog.suggestionPolicy.vote.maxVotersPerSuggestion} voters, retains at most ${catalog.suggestionPolicy.vote.maxRetainedSuggestions} suggestions for ${catalog.suggestionPolicy.vote.retentionDays} days, and never writes state on reads.`,
    "- Votes only rank proposal priority by votes descending, then creation time ascending, then suggestion ID ascending. They never mint tiles, approve scope, or bypass writer trust, magnus-only scope, or critic review.",
    "",
    "## Catalog entries",
    "",
  ];
  if (!bounties.length) {
    lines.push("No catalog bounties are open. Add a fully specified record to the protected catalog, regenerate this mirror, and pass the validator before a bounty can be claimed.");
  } else {
    lines.push("| ID | Type | Status | Scope | Reward | Base | Scope hash |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const bounty of bounties) {
      const base = bounty.base.policy === "exact-sha" ? bounty.base.sha : bounty.base.policy;
      lines.push(`| \`${bounty.id}\` | ${bounty.type} | ${bounty.status} | ${bounty.scopeClass} | ${bounty.rewardType} | \`${base}\` | \`${bounty.scopeHash}\` |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
