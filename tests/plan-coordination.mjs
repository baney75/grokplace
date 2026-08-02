#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = "", limit = 1_000 } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const now = Date.now();
const owner = "plan-owner";
const guest = "plan-guest";
const primaryId = "pl_1111111111111111";
const sourceId = "pl_2222222222222222";
const similarId = "pl_3333333333333333";

function plan(id, agent, overrides = {}) {
  return {
    id,
    agent,
    clientRequestId: `request-${id.slice(-8)}`,
    title: "Blue square corner",
    goal: "Build a blue square corner",
    summary: "A bounded blue mosaic detail.",
    region: "northwest",
    bounds: { x: 0, y: 0, w: 4, h: 4 },
    steps: [{ n: 1, text: "Paint the allocated cells", done: false }],
    design: { w: 4, h: 4, cells: [{ x: 0, y: 0, c: 0, color: "#FFFFFF" }, { x: 1, y: 0, c: 13, color: "#0000EA" }] },
    palette: [0, 13],
    tileBudget: 8,
    estimatedTurns: 2,
    status: "active",
    ownerConsentAttestedByAgent: true,
    attestedAt: now,
    progress: { notes: "" },
    acceptedPlacements: 0,
    version: 1,
    activatedVersion: 1,
    acceptedReviewId: "pvr_aaaaaaaaaaaaaaaa",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const sourcePlan = plan(sourceId, guest, {
  title: "Blue corner companion",
  bounds: { x: 2, y: 0, w: 2, h: 3 },
  assignments: [{
    id: "as_aaaaaaaaaaaa",
    agent: guest,
    bounds: { x: 2, y: 0, w: 1, h: 2 },
    cells: [],
    tileBudget: 2,
    dependencies: [],
    completionCondition: "Paint the companion edge",
    status: "active",
    acceptedPlacements: 0,
    createdAt: now,
    updatedAt: now,
  }],
});
const primaryPlan = plan(primaryId, owner);
const similarPlan = plan(similarId, "similar-agent", {
  title: "Blue square border",
  goal: "Build a blue square border",
  bounds: { x: 3, y: 0, w: 2, h: 3 },
  status: "previewing",
});
const additionalSimilarPlans = Array.from({ length: 9 }, (_, index) => {
  const id = `pl_${(index + 5).toString(16).padStart(16, "0")}`;
  return plan(id, `similar-${index}`, {
    title: `Blue square detail ${index}`,
    goal: "Build a blue square detail",
    bounds: null,
    status: "previewing",
    updatedAt: now - index - 3,
  });
});
const storage = new MemoryStorage({
  [`plan:${primaryId}`]: primaryPlan,
  [`plan:${sourceId}`]: sourcePlan,
  [`plan:${similarId}`]: similarPlan,
  planIndex: [
    { id: primaryId, agent: owner, updatedAt: now, status: "active", bounds: primaryPlan.bounds },
    { id: sourceId, agent: guest, updatedAt: now - 1, status: "active", bounds: sourcePlan.bounds },
    { id: similarId, agent: "similar-agent", updatedAt: now - 2, status: "previewing", bounds: similarPlan.bounds },
    ...additionalSimilarPlans.map((item) => ({ id: item.id, agent: item.agent, updatedAt: item.updatedAt, status: item.status, bounds: item.bounds })),
  ],
  [`agent:${guest}`]: { name: guest, joinedPlanIds: [], avoidedPlanIds: [] },
  [`agent:${owner}`]: { name: owner, joinedPlanIds: [], avoidedPlanIds: [] },
});
for (const item of additionalSimilarPlans) await storage.put(`plan:${item.id}`, item);
const canvas = new GrokPlaceCanvas({ storage }, { CANVAS_SIZE: "8" });
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async () => ({ ok: true });

function request(path, body) {
  return new Request(`https://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: "test", nonce: 0, ...body }),
  });
}

async function place(agent, body) {
  const response = await canvas.handlePlace(request("/internal/place", { agent, goal: "blue square corner", ...body }), 8, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}

let response = await canvas.handleSimilarPlans(new URL(`https://test/internal/plans/similar?id=${primaryId}`), "*");
let data = await response.json();
const nearMatch = data.matches?.find((match) => match.plan?.id === similarId);
check(
  "local similarity is deterministic, capped, and explains goal, palette, design, and status evidence",
  response.ok
    && data.matches.length === 8
    && data.limits?.localOnly === true
    && nearMatch?.reasons?.some((reason) => reason.kind === "goal_terms")
    && nearMatch?.reasons?.some((reason) => reason.kind === "palette")
    && nearMatch?.reasons?.some((reason) => reason.kind === "design_dimensions")
    && nearMatch?.reasons?.some((reason) => reason.kind === "status"),
  JSON.stringify(data)
);

canvas.requireAgentCapability = async () => ({ ok: false, status: 403, error: "agent_capability_invalid", message: "test capability denial" });
response = await canvas.handlePlanAgreement(request("/internal/plans/agreements", {
  agent: guest,
  planId: primaryId,
  action: "work-adjacent",
  message: "I will keep to the adjacent edge.",
}), "*", "test-ip");
data = await response.json();
check("coordination proposals require the agent capability", response.status === 403 && data.error === "agent_capability_invalid", JSON.stringify(data));
canvas.requireAgentCapability = async () => ({ ok: true });

response = await canvas.handlePlanAgreement(request("/internal/plans/agreements", {
  agent: guest,
  planId: primaryId,
  action: "join",
  message: "I can paint the allocated cells.",
}), "*", "test-ip");
data = await response.json();
check(
  "authenticated join creates a bounded accepted agreement and membership",
  response.status === 201
    && data.agreement?.action === "join"
    && data.agreement?.status === "accepted"
    && data.memberships?.joined?.includes(primaryId),
  JSON.stringify(data)
);

const acceptedCoordination = [];
for (const proposal of [
  { agent: guest, action: "coordinate", message: "I will paint after the border." },
  { agent: "similar-agent", action: "work-adjacent", message: "I will use the neighboring area." },
  { agent: "similar-agent", action: "avoid", message: "I will avoid this plan region." },
]) {
  response = await canvas.handlePlanAgreement(request("/internal/plans/agreements", { planId: primaryId, ...proposal }), "*", "test-ip");
  data = await response.json();
  acceptedCoordination.push(response.status === 201 && data.agreement?.action === proposal.action && data.agreement?.status === "accepted");
}
check("coordinate, avoid, and work-adjacent agreements are authenticated bounded proposals", acceptedCoordination.every(Boolean), JSON.stringify(acceptedCoordination));

response = await canvas.handlePlanAgreement(request("/internal/plans/agreements", {
  agent: guest,
  planId: primaryId,
  action: "merge",
  sourcePlanId: sourceId,
  proposedBounds: { x: 0, y: 0, w: 4, h: 3 },
  message: "Merge the shared border only.",
}), "*", "test-ip");
data = await response.json();
const agreementId = data.agreement?.id;
check(
  "merge and material-bounds proposals remain pending for the target owner",
  response.status === 201
    && data.agreement?.status === "pending"
    && data.ownerAcceptanceRequired === true
    && (await storage.get(`plan:${primaryId}`))?.bounds?.h === 4,
  JSON.stringify(data)
);

const limitId = "pl_eeeeeeeeeeeeeeee";
const agreementLimitPlan = plan(limitId, owner, {
  agreements: Array.from({ length: 16 }, (_, index) => ({
    id: `ag_${index.toString(16).padStart(12, "0")}`,
    agent: guest,
    action: "join",
    status: "accepted",
    message: "",
    createdAt: now,
    updatedAt: now,
  })),
});
await storage.put(`plan:${limitId}`, agreementLimitPlan);
response = await canvas.handlePlanAgreement(request("/internal/plans/agreements", {
  agent: owner,
  planId: limitId,
  action: "coordinate",
  message: "Request beyond the retained agreement limit.",
}), "*", "test-ip");
data = await response.json();
check("agreement retention rejects proposals after the fixed per-plan limit", response.status === 429 && data.error === "agreement_capacity" && data.max === 16, JSON.stringify(data));

response = await canvas.handlePlanAgreementDecision(request("/internal/plans/agreements/decision", {
  agent: guest,
  planId: primaryId,
  agreementId,
  accept: true,
}), "*", "test-ip");
data = await response.json();
check("only the target owner can accept a merge or material bounds", response.status === 403 && data.error === "not_yours", JSON.stringify(data));

response = await canvas.handlePlanAgreementDecision(request("/internal/plans/agreements/decision", {
  agent: owner,
  planId: primaryId,
  agreementId,
  accept: true,
}), "*", "test-ip");
data = await response.json();
check(
  "owner acceptance records material bounds without mutating the attested live revision",
  response.ok
    && data.agreement?.status === "accepted"
    && data.agreement?.proposedBounds?.h === 3
    && data.plan?.bounds?.h === 4
    && data.plan?.version === 1
    && data.plan?.activation?.active === true
    && data.plan?.activation?.version === 1
    && data.revisionRequired === true,
  JSON.stringify(data)
);

response = await canvas.handlePlanAssignment(request("/internal/plans/assignments", {
  agent: guest,
  planId: primaryId,
  assignment: {
    agent: guest,
    cells: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
    tileBudget: 2,
    dependencies: [],
    completionCondition: "Paint both assigned cells.",
  },
}), "*", "test-ip");
data = await response.json();
check("only a plan owner can create shared work allocations", response.status === 403 && data.error === "not_yours", JSON.stringify(data));

response = await canvas.handlePlanAssignment(request("/internal/plans/assignments", {
  agent: owner,
  planId: primaryId,
  assignment: {
    agent: guest,
    cells: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
    tileBudget: 2,
    dependencies: [],
    completionCondition: "Paint both assigned cells.",
  },
}), "*", "test-ip");
data = await response.json();
const assignmentId = data.assignment?.id;
check(
  "assignments retain agent, exact cells, budget, dependencies, and completion condition",
  response.status === 201
    && /^as_[a-f0-9]{12}$/i.test(assignmentId || "")
    && data.assignment?.agent === guest
    && data.assignment?.cells?.length === 2
    && data.assignment?.tileBudget === 2
    && data.assignment?.completionCondition === "Paint both assigned cells.",
  JSON.stringify(data)
);

let placed = await place(guest, { planId: primaryId, x: 1, y: 0, color: 13 });
check("active allocations require an assignment id on plan-associated placement", placed.response.status === 409 && placed.data.error === "assignment_required", JSON.stringify(placed.data));

placed = await place(guest, { planId: primaryId, assignmentId, x: 0, y: 0, color: 13 });
check("assignment cells enforce exact placement bounds", placed.response.status === 400 && placed.data.error === "outside_assignment_region", JSON.stringify(placed.data));

placed = await place(guest, { planId: primaryId, assignmentId, tiles: [{ x: 1, y: 0, color: 13 }, { x: 2, y: 0, color: 13 }] });
check(
  "accepted plan placements debit only the matching assignment budget and retain the association",
  placed.response.ok && placed.data.assignment?.acceptedPlacements === 2 && placed.data.plan?.progress?.acceptedPlacements === 2,
  JSON.stringify(placed.data)
);

placed = await place(guest, { planId: primaryId, assignmentId, x: 1, y: 0, color: 13 });
check("assignment budget rejects further plan-associated placement", placed.response.status === 409 && placed.data.error === "assignment_budget", JSON.stringify(placed.data));

await storage.put("protection:cell:1:0", {
  version: 1,
  x: 1,
  y: 0,
  colorIndex: 13,
  color: "#0000EA",
  protector: owner,
  protectedAt: now,
  expiresAt: now + 60_000,
});
response = await canvas.handlePlanConflicts(new URL(`https://test/internal/plans/conflicts?id=${primaryId}`), 8, "*");
data = await response.json();
check(
  "conflict discovery returns exact plan, assignment, and protected cells within fixed limits",
  response.ok
    && data.conflicts.length <= data.limits?.conflictMax
    && data.conflicts.some((conflict) => conflict.type === "plan" && conflict.cells.some((cell) => cell.x === 2 && cell.y === 0))
    && data.conflicts.some((conflict) => conflict.type === "assignment" && conflict.cells.some((cell) => cell.x === 2 && cell.y === 0))
    && data.conflicts.some((conflict) => conflict.type === "protection" && conflict.cells[0]?.x === 1 && conflict.cells[0]?.y === 0),
  JSON.stringify(data)
);

const legacyDone = { ...plan("pl_4444444444444444", owner), status: "done", palette: undefined, goal: undefined };
await storage.put(`plan:${legacyDone.id}`, legacyDone);
response = await canvas.handlePlanGet(new URL(`https://test/internal/plan?id=${legacyDone.id}`), "*");
data = await response.json();
check(
  "legacy plan statuses and records remain readable alongside structured statuses",
  response.ok && data.plan?.status === "done" && data.plan?.goal === legacyDone.title && Array.isArray(data.plan?.palette),
  JSON.stringify(data)
);

process.exitCode = failed ? 1 : 0;
