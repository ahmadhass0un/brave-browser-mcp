import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { start as startWsServer } from './ws-server.js';
import * as bridge from './bridge.js';
import { registerTools } from './tools.js';

const DATA_DIR = join(process.cwd(), 'data');
const BOOKMARKS_FILE = join(DATA_DIR, 'bookmarks', 'bookmarks.json');
const HISTORY_FILE = join(DATA_DIR, 'history', 'history.json');

let bookmarks = [];
let browsingHistory = [];

function loadJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJson(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }

function saveBookmarks() { saveJson(BOOKMARKS_FILE, bookmarks); }
function saveHistory() { saveJson(HISTORY_FILE, browsingHistory); }

function addHistoryEntry(entry) {
  browsingHistory.unshift({ ...entry, timestamp: Date.now() });
  if (browsingHistory.length > 5000) browsingHistory.length = 5000;
  saveHistory();
}

export async function main() {
  bookmarks = loadJson(BOOKMARKS_FILE, []);
  browsingHistory = loadJson(HISTORY_FILE, []);

  const wsPort = parseInt(process.env.BROWSER_NAV_WS_PORT || '9224');
  startWsServer(wsPort);

  const server = new McpServer({
    name: 'browser-navigator',
    version: '2.0.0',
  });

  registerTools(server, { bookmarks, browsingHistory, addHistoryEntry, saveBookmarks, saveHistory, wsPort });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`browser-navigator MCP server v2.0.0 started (stdio + ws:${wsPort}), ${bookmarks.length} bookmarks, ${browsingHistory.length} history entries`);
}
