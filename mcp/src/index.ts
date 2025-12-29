import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";
const API_TOKEN = process.env.SHORTCUT_API_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

if (!API_TOKEN) {
  console.error("SHORTCUT_API_TOKEN environment variable is required");
  process.exit(1);
}

// Cache with TTL
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

function isCacheValid<T>(cache: CacheEntry<T> | null): cache is CacheEntry<T> {
  return cache !== null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

// REST API helper with rate limiting and empty response handling
async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  retries = 3
): Promise<unknown> {
  const response = await fetch(`${SHORTCUT_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Shortcut-Token": API_TOKEN!,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle rate limiting
  if (response.status === 429) {
    if (retries > 0) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return api(method, path, body, retries - 1);
    }
    throw new Error("Rate limit exceeded. Please try again later.");
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  // Handle empty responses (204 No Content)
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ID resolution with validation
function resolveId(input: string): number {
  // Shortcut URL pattern
  const urlMatch = input.match(/shortcut\.com\/[^/]+\/story\/(\d+)/i);
  if (urlMatch) {
    const id = parseInt(urlMatch[1], 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  // Epic URL pattern
  const epicUrlMatch = input.match(/shortcut\.com\/[^/]+\/epic\/(\d+)/i);
  if (epicUrlMatch) {
    const id = parseInt(epicUrlMatch[1], 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  // sc-704 or just 704
  const numMatch = input.match(/(\d+)/);
  if (numMatch) {
    const id = parseInt(numMatch[1], 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  throw new Error(`Invalid ID: ${input}`);
}

// Cache for workflows and members
let cachedMember: CacheEntry<Record<string, unknown>> | null = null;
let cachedWorkflows: CacheEntry<Array<Record<string, unknown>>> | null = null;
let cachedMembers: CacheEntry<Array<Record<string, unknown>>> | null = null;

async function getCurrentMember(): Promise<Record<string, unknown>> {
  if (isCacheValid(cachedMember)) return cachedMember.data;
  const data = (await api("GET", "/member")) as Record<string, unknown>;
  cachedMember = { data, timestamp: Date.now() };
  return data;
}

async function getWorkflows(): Promise<Array<Record<string, unknown>>> {
  if (isCacheValid(cachedWorkflows)) return cachedWorkflows.data;
  const data = (await api("GET", "/workflows")) as Array<Record<string, unknown>>;
  cachedWorkflows = { data, timestamp: Date.now() };
  return data;
}

async function getMembers(): Promise<Array<Record<string, unknown>>> {
  if (isCacheValid(cachedMembers)) return cachedMembers.data;
  const data = (await api("GET", "/members")) as Array<Record<string, unknown>>;
  cachedMembers = { data, timestamp: Date.now() };
  return data;
}

// Get workflow state by ID
async function getStateName(stateId: number): Promise<string> {
  const workflows = await getWorkflows();
  for (const wf of workflows) {
    const states = (wf.states as Array<Record<string, unknown>> | undefined) || [];
    const state = states.find((s) => s.id === stateId);
    if (state) return state.name as string;
  }
  return String(stateId);
}

// Fuzzy match state name to ID
async function resolveState(stateName: string): Promise<number | null> {
  const workflows = await getWorkflows();
  const lower = stateName.toLowerCase();

  for (const wf of workflows) {
    const states = (wf.states as Array<Record<string, unknown>> | undefined) || [];

    // Exact match first
    let match = states.find((s) => {
      const name = s.name as string | undefined;
      return name && name.toLowerCase() === lower;
    });
    if (match) return match.id as number;

    // Partial match
    match = states.find((s) => {
      const name = s.name as string | undefined;
      return name && name.toLowerCase().includes(lower);
    });
    if (match) return match.id as number;
  }

  // Common aliases
  const aliases: Record<string, string[]> = {
    done: ["done", "complete", "completed", "finished", "deployed"],
    "in progress": ["in progress", "started", "doing", "wip", "in prog", "development"],
    ready: ["ready", "todo", "to do", "backlog", "open", "ready for"],
    review: ["review", "code review", "pr", "pull request"],
  };

  for (const [canonical, alts] of Object.entries(aliases)) {
    if (alts.some((a) => lower.includes(a) || a.includes(lower))) {
      for (const wf of workflows) {
        const states = (wf.states as Array<Record<string, unknown>> | undefined) || [];
        const match = states.find((s) => {
          const name = s.name as string | undefined;
          return name && name.toLowerCase().includes(canonical);
        });
        if (match) return match.id as number;
      }
    }
  }

  return null;
}

// Resolve member by name or "me"
async function resolveMember(input: string): Promise<string | null> {
  if (input === "me") {
    const member = await getCurrentMember();
    return member.id as string;
  }

  const members = await getMembers();
  const lower = input.toLowerCase();

  const match = members.find((m) => {
    const profile = m.profile as Record<string, unknown> | null | undefined;
    if (!profile) return false;
    const name = String(profile.name || "").toLowerCase();
    const mention = String(profile.mention_name || "").toLowerCase();
    return name.includes(lower) || mention.includes(lower);
  });

  return match ? (match.id as string) : null;
}

// Format story for output with null safety
function formatStory(story: Record<string, unknown>, stateName?: string): string {
  const labels = ((story.labels as Array<{ name: string }> | undefined) || [])
    .filter((l): l is { name: string } => l != null && typeof l.name === "string")
    .map((l) => l.name)
    .join(", ");

  const lines = [
    `**sc-${story.id}**: ${story.name || "Untitled"}`,
    `Type: ${story.story_type || "?"} | State: ${stateName || story.workflow_state_id || "?"} | Est: ${story.estimate ?? "?"} pts`,
    `Epic: ${story.epic_id || "none"} | Iteration: ${story.iteration_id || "none"}`,
  ];

  if (labels) lines.push(`Labels: ${labels}`);
  if (story.app_url) lines.push(`Link: ${story.app_url}`);
  if (story.description) lines.push("", String(story.description));

  return lines.join("\n");
}

// Format story list with null safety
function formatStoryList(stories: Array<Record<string, unknown>>): string {
  if (!stories || stories.length === 0) return "No stories found.";

  return stories
    .filter((s): s is Record<string, unknown> => s != null)
    .map((s) => {
      const state = s.completed ? "done" : s.started ? "started" : "unstarted";
      return `- **sc-${s.id}** [${state}] ${s.name || "Untitled"} (${s.story_type || "?"}, ${s.estimate ?? "?"}pts)`;
    })
    .join("\n");
}

// Normalize search response (handles both array and {data:[]} formats)
function normalizeSearchResponse(response: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === "object" && "data" in response) {
    const data = (response as { data: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

// Action handlers
async function handleSearch(query?: string | Record<string, unknown>): Promise<string> {
  let searchParams: Record<string, unknown> = {};

  if (!query) {
    // Default: my active stories
    const member = await getCurrentMember();
    searchParams = {
      owner_ids: [member.id],
      archived: false,
    };
  } else if (typeof query === "string") {
    // Text search using Shortcut query syntax
    searchParams = { query };
  } else {
    // Build search from object
    if (query.owner === "me") {
      const member = await getCurrentMember();
      searchParams.owner_ids = [member.id];
    } else if (query.owner) {
      const memberId = await resolveMember(query.owner as string);
      if (memberId) searchParams.owner_ids = [memberId];
    }

    if (query.state) {
      const stateId = await resolveState(query.state as string);
      if (stateId) searchParams.workflow_state_id = stateId;
    }

    if (query.epic) searchParams.epic_ids = [query.epic];
    if (query.iteration) searchParams.iteration_ids = [query.iteration];
    if (query.type) searchParams.story_type = query.type;
    if (query.archived !== undefined) searchParams.archived = query.archived;
  }

  const response = await api("POST", "/stories/search", searchParams);
  const stories = normalizeSearchResponse(response);

  return formatStoryList(stories);
}

async function handleGet(id: string): Promise<string> {
  const storyId = resolveId(id);
  const story = (await api("GET", `/stories/${storyId}`)) as Record<string, unknown>;

  if (!story) {
    return `Story sc-${storyId} not found`;
  }

  const stateName = await getStateName(story.workflow_state_id as number);
  let result = formatStory(story, stateName);

  // Include recent comments
  const comments = story.comments as Array<Record<string, unknown>> | undefined;
  if (comments && comments.length > 0) {
    result += "\n\n## Recent Comments\n";
    result += comments
      .slice(0, 5)
      .filter((c): c is Record<string, unknown> => c != null)
      .map((c) => `**${c.author_id || "Unknown"}** (${c.created_at || "?"}):\n${c.text || ""}`)
      .join("\n\n");
  }

  return result;
}

async function handleUpdate(
  id: string,
  updates: {
    state?: string;
    estimate?: number;
    owner?: string | null;
    type?: string;
    name?: string;
    description?: string;
  }
): Promise<string> {
  const storyId = resolveId(id);
  const input: Record<string, unknown> = {};

  if (updates.state) {
    const stateId = await resolveState(updates.state);
    if (stateId) {
      input.workflow_state_id = stateId;
    } else {
      const workflows = await getWorkflows();
      const allStates = workflows
        .flatMap((wf) => ((wf.states as Array<Record<string, unknown>> | undefined) || []).map((s) => s.name))
        .join(", ");
      return `State "${updates.state}" not found. Valid states: ${allStates}`;
    }
  }

  if (updates.estimate !== undefined) input.estimate = updates.estimate;
  if (updates.name) input.name = updates.name;
  if (updates.description) input.description = updates.description;
  if (updates.type) input.story_type = updates.type;

  if (updates.owner !== undefined) {
    if (updates.owner === null) {
      input.owner_ids = [];
    } else {
      const memberId = await resolveMember(updates.owner);
      if (memberId) {
        input.owner_ids = [memberId];
      } else {
        return `Could not find member "${updates.owner}"`;
      }
    }
  }

  if (Object.keys(input).length === 0) {
    return "No updates provided";
  }

  const story = (await api("PUT", `/stories/${storyId}`, input)) as Record<string, unknown>;
  const stateName = await getStateName(story.workflow_state_id as number);

  const changes: string[] = [];
  if (updates.state) changes.push(`state → ${stateName}`);
  if (updates.estimate !== undefined) changes.push(`estimate → ${updates.estimate}`);
  if (updates.owner !== undefined) changes.push(`owner → ${updates.owner || "unassigned"}`);
  if (updates.name) changes.push(`name updated`);
  if (updates.type) changes.push(`type → ${updates.type}`);

  return `Updated sc-${story.id}: ${changes.join(", ")}\n${story.app_url}`;
}

async function handleComment(id: string, body: string): Promise<string> {
  const storyId = resolveId(id);

  await api("POST", `/stories/${storyId}/comments`, { text: body });

  const truncated = body.length > 100 ? body.slice(0, 100) + "..." : body;
  return `Added comment to sc-${storyId}:\n> ${truncated}`;
}

async function handleCreate(
  name: string,
  options: {
    description?: string;
    type?: string;
    estimate?: number;
    epic?: number;
    iteration?: number;
    state?: string;
    owner?: string;
    labels?: string[];
  }
): Promise<string> {
  const input: Record<string, unknown> = { name };

  // Get default workflow state if not provided
  if (options.state) {
    const stateId = await resolveState(options.state);
    if (stateId) input.workflow_state_id = stateId;
  } else {
    // Use first "unstarted" state from default workflow
    const workflows = await getWorkflows();
    if (workflows.length > 0) {
      const states = (workflows[0].states as Array<Record<string, unknown>> | undefined) || [];
      const readyState = states.find((s) => (s.type as string) === "unstarted");
      if (readyState) input.workflow_state_id = readyState.id;
    }
  }

  if (options.description) input.description = options.description;
  if (options.type) input.story_type = options.type;
  if (options.estimate !== undefined) input.estimate = options.estimate;
  if (options.epic) input.epic_id = options.epic;
  if (options.iteration) input.iteration_id = options.iteration;

  if (options.owner) {
    const memberId = await resolveMember(options.owner);
    if (memberId) input.owner_ids = [memberId];
  }

  if (options.labels && options.labels.length > 0) {
    input.labels = options.labels.map((labelName) => ({ name: labelName }));
  }

  const story = (await api("POST", "/stories", input)) as Record<string, unknown>;
  return `Created sc-${story.id}: ${story.name}\n${story.app_url}`;
}

async function handleEpic(id: string): Promise<string> {
  const epicId = resolveId(id);
  const epic = (await api("GET", `/epics/${epicId}`)) as Record<string, unknown>;

  if (!epic) {
    return `Epic ${epicId} not found`;
  }

  const stats = epic.stats as Record<string, number> | undefined;
  let result = `**Epic ${epic.id}**: ${epic.name || "Untitled"}
State: ${epic.state || "?"} | Stories: ${stats?.num_stories_total || 0} (${stats?.num_stories_done || 0} done)
Link: ${epic.app_url || "N/A"}`;

  // Fetch stories in this epic
  const response = await api("POST", "/stories/search", { epic_ids: [epicId] });
  const stories = normalizeSearchResponse(response);

  if (stories.length > 0) {
    result += "\n\n## Stories\n" + formatStoryList(stories.slice(0, 25));
    if (stories.length > 25) {
      result += `\n... and ${stories.length - 25} more`;
    }
  }

  return result;
}

async function handleApi(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<string> {
  // Validate path
  if (!path.startsWith("/")) {
    throw new Error("Path must start with /");
  }

  const result = await api(method.toUpperCase(), path, body);
  return JSON.stringify(result, null, 2);
}

function handleHelp(): string {
  return `# Shortcut MCP

## Actions

**search** - Find stories
  {"action": "search"}                              → your active stories
  {"action": "search", "query": "auth bug"}         → text search
  {"action": "search", "query": {"state": "In Progress", "owner": "me"}}

**get** - Story details (accepts 704, sc-704, or URLs)
  {"action": "get", "id": "704"}

**update** - Change state, estimate, owner
  {"action": "update", "id": "704", "state": "Done"}
  {"action": "update", "id": "704", "estimate": 3}
  {"action": "update", "id": "704", "owner": "me"}
  {"action": "update", "id": "704", "owner": null}  → unassign

**comment** - Add comment to story
  {"action": "comment", "id": "704", "body": "Fixed in abc123"}

**create** - Create new story
  {"action": "create", "name": "Bug title"}
  {"action": "create", "name": "Bug", "type": "bug", "estimate": 2, "epic": 308}

**epic** - Get epic with its stories
  {"action": "epic", "id": "308"}

**api** - Raw REST API for anything else
  {"action": "api", "method": "GET", "path": "/workflows"}
  {"action": "api", "method": "POST", "path": "/stories/search", "query": {"epic_ids": [308]}}

## Reference

Story types: feature, bug, chore

Estimate: story points (typically 1, 2, 3, 5, 8)

Query filters: {owner: "me"|name, state: "name", epic: id, iteration: id, type: "feature"|"bug"|"chore"}

State matching is fuzzy: "done" → "Done", "in prog" → "In Progress"

IDs accept: 704, sc-704, or shortcut.com URLs`;
}

// Tool parameter schema
const ShortcutParams = z.object({
  action: z.enum(["search", "get", "update", "comment", "create", "epic", "api", "help"]),
  query: z.union([z.string(), z.record(z.unknown())]).optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  estimate: z.number().optional(),
  owner: z.string().nullable().optional(),
  type: z.enum(["feature", "bug", "chore"]).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  epic: z.number().optional(),
  iteration: z.number().optional(),
  labels: z.array(z.string()).optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});

// Build dynamic tool description with workflow states
async function buildToolDescription(): Promise<string> {
  const workflows = await getWorkflows();

  const stateLines = workflows.map((wf) => {
    const states = (wf.states as Array<Record<string, unknown>> | undefined) || [];
    const stateNames = states.map((s) => s.name as string).join(", ");
    return `  ${wf.name}: ${stateNames}`;
  });

  return `Shortcut stories. Actions: help, search, get, update, comment, create, epic, api

Workflows (states):
${stateLines.join("\n")}

{"action": "search"} → your active stories
{"action": "search", "query": "text"} → text search
{"action": "get", "id": "704"} → story details
{"action": "update", "id": "704", "state": "Done"}
{"action": "create", "name": "Title", "type": "feature"}
{"action": "epic", "id": "308"} → epic with stories
{"action": "help"} → full documentation`;
}

// Create MCP server
const server = new McpServer({
  name: "shortcut",
  version: "1.0.0",
});

// Initialize with proper error handling
let toolDescription: string;
try {
  toolDescription = await buildToolDescription();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Failed to initialize StreamShortcut: ${msg}`);
  console.error("Check your SHORTCUT_API_TOKEN and network connection.");
  process.exit(1);
}

// Register single tool
server.tool(
  "shortcut",
  toolDescription,
  ShortcutParams.shape,
  async (args) => {
    const params = ShortcutParams.parse(args);

    try {
      let result: string;

      switch (params.action) {
        case "search":
          result = await handleSearch(params.query);
          break;

        case "get":
          if (!params.id) throw new Error("id is required for get action");
          result = await handleGet(params.id);
          break;

        case "update":
          if (!params.id) throw new Error("id is required for update action");
          result = await handleUpdate(params.id, {
            state: params.state,
            estimate: params.estimate,
            owner: params.owner,
            type: params.type,
            name: params.name,
            description: params.description,
          });
          break;

        case "comment":
          if (!params.id) throw new Error("id is required for comment action");
          if (!params.body) throw new Error("body is required for comment action");
          result = await handleComment(params.id, params.body);
          break;

        case "create":
          if (!params.name) throw new Error("name is required for create action");
          result = await handleCreate(params.name, {
            description: params.description,
            type: params.type,
            estimate: params.estimate,
            epic: params.epic,
            iteration: params.iteration,
            state: params.state,
            owner: params.owner,
            labels: params.labels,
          });
          break;

        case "epic":
          if (!params.id) throw new Error("id is required for epic action");
          result = await handleEpic(params.id);
          break;

        case "api":
          if (!params.method) throw new Error("method is required for api action");
          if (!params.path) throw new Error("path is required for api action");
          result = await handleApi(
            params.method,
            params.path,
            params.query as Record<string, unknown> | undefined
          );
          break;

        case "help":
          result = handleHelp();
          break;

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }

      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
