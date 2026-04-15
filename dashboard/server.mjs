#!/usr/bin/env node
/**
 * Cyber Boss Dashboard: Express backend for project tracking, OKRs,
 * bot registry, and Feishu task sync.
 */

import express from "express";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "18062", 10);
const DATA_DIR = process.env.CB_DATA_DIR || path.join(__dirname, "data");
const DAILY_LOG_DIR =
  process.env.CB_DAILY_LOG_DIR ||
  "/opt/openclaw/data/workspace/cyber-boss/memory";

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "dashboard.db");

// ── SQLite ───────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','done','archived')),
    intro_markdown TEXT DEFAULT '',
    owner TEXT DEFAULT '',
    start_date TEXT,
    target_date TEXT,
    is_focus INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS objectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT DEFAULT 'project' CHECK(scope IN ('company','project')),
    project_id INTEGER,
    period TEXT NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'on_track' CHECK(status IN ('on_track','at_risk','off_track')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS key_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    metric_type TEXT DEFAULT 'percent' CHECK(metric_type IN ('percent','number','boolean')),
    baseline REAL DEFAULT 0,
    current_value REAL DEFAULT 0,
    target_value REAL DEFAULT 100,
    weight REAL DEFAULT 1,
    confidence_score TEXT DEFAULT 'green' CHECK(confidence_score IN ('green','yellow','red')),
    status TEXT DEFAULT 'active',
    update_source TEXT DEFAULT 'manual' CHECK(update_source IN ('manual','feishu_task_ratio','feishu_bitable')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kr_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kr_id INTEGER NOT NULL,
    old_value REAL,
    new_value REAL,
    confidence_score TEXT,
    note TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    updated_by TEXT DEFAULT 'dashboard',
    FOREIGN KEY (kr_id) REFERENCES key_results(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','cancelled')),
    linked_kr_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (linked_kr_id) REFERENCES key_results(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT '',
    description TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    linked_projects TEXT DEFAULT '[]',
    last_sync_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_bot_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    bot_id INTEGER NOT NULL,
    responsibility TEXT DEFAULT '',
    contribution_weight REAL DEFAULT 1,
    UNIQUE(project_id, bot_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT,
    title TEXT,
    status TEXT,
    priority TEXT,
    project_slug TEXT,
    milestone TEXT,
    linked_kr_code TEXT,
    assignee TEXT,
    due_date TEXT,
    estimated_hours REAL DEFAULT 0,
    task_type TEXT,
    blocker TEXT,
    consecutive_delay_days INTEGER DEFAULT 0,
    raw_json TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    status TEXT DEFAULT 'running' CHECK(status IN ('running','success','error')),
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    records_synced INTEGER DEFAULT 0,
    error_summary TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Settings Helpers ─────────────────────────────────────────────

function getSetting(key, defaultValue = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}
function setSetting(key, value) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run(key, String(value));
}

// Seed defaults
if (!getSetting("current_period")) setSetting("current_period", "2026-Q2");
if (!getSetting("feishu_base_id")) setSetting("feishu_base_id", "");
if (!getSetting("feishu_table_id")) setSetting("feishu_table_id", "");

// ── Express ──────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Projects API ─────────────────────────────────────────────────

app.get("/api/projects", (req, res) => {
  let sql = "SELECT * FROM projects WHERE 1=1";
  const params = [];
  if (req.query.status) {
    sql += " AND status = ?";
    params.push(req.query.status);
  }
  if (req.query.is_focus === "1") {
    sql += " AND is_focus = 1";
  }
  sql += " ORDER BY is_focus DESC, updated_at DESC";
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map((r) => ({ ...r, progress: computeProjectProgress(r) })));
});

app.post("/api/projects", (req, res) => {
  const {
    slug,
    name,
    status = "active",
    intro_markdown = "",
    owner = "",
    start_date,
    target_date,
    is_focus = 0,
  } = req.body;
  if (!slug || !name)
    return res.status(400).json({ error: "slug and name required" });
  try {
    const info = db
      .prepare(
        `INSERT INTO projects (slug, name, status, intro_markdown, owner, start_date, target_date, is_focus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        name,
        status,
        intro_markdown,
        owner,
        start_date || null,
        target_date || null,
        is_focus ? 1 : 0
      );
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message))
      return res.status(409).json({ error: "slug already exists" });
    throw e;
  }
});

app.get("/api/projects/:id", (req, res) => {
  const row = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });

  const milestones = db
    .prepare(
      "SELECT * FROM milestones WHERE project_id = ? ORDER BY due_date"
    )
    .all(row.id);
  const objectives = db
    .prepare(
      "SELECT * FROM objectives WHERE project_id = ? ORDER BY period DESC, code"
    )
    .all(row.id);
  for (const obj of objectives) {
    obj.key_results = db
      .prepare("SELECT * FROM key_results WHERE objective_id = ? ORDER BY code")
      .all(obj.id);
  }
  const tasks = db
    .prepare(
      "SELECT * FROM task_snapshots WHERE project_slug = ? ORDER BY synced_at DESC LIMIT 50"
    )
    .all(row.slug);
  const botLinks = db
    .prepare(
      `SELECT pbl.*, b.agent_id, b.name as bot_name, b.role as bot_role
       FROM project_bot_links pbl JOIN bots b ON pbl.bot_id = b.id
       WHERE pbl.project_id = ?`
    )
    .all(row.id);
  const blockers = db
    .prepare(
      "SELECT * FROM task_snapshots WHERE project_slug = ? AND blocker != '' AND blocker IS NOT NULL ORDER BY priority"
    )
    .all(row.slug);

  res.json({
    ...row,
    progress: computeProjectProgress(row),
    milestones,
    objectives,
    tasks,
    bot_links: botLinks,
    blockers,
  });
});

app.put("/api/projects/:id", (req, res) => {
  const row = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const fields = [
    "name",
    "slug",
    "status",
    "intro_markdown",
    "owner",
    "start_date",
    "target_date",
    "is_focus",
  ];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(f === "is_focus" ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (updates.length === 0) return res.json({ success: true });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json({ success: true });
});

app.delete("/api/projects/:id", (req, res) => {
  const exists = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!exists) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Objectives API ───────────────────────────────────────────────

app.get("/api/objectives", (req, res) => {
  let sql = "SELECT * FROM objectives WHERE 1=1";
  const params = [];
  if (req.query.scope) {
    sql += " AND scope = ?";
    params.push(req.query.scope);
  }
  if (req.query.project_id) {
    sql += " AND project_id = ?";
    params.push(req.query.project_id);
  }
  if (req.query.period) {
    sql += " AND period = ?";
    params.push(req.query.period);
  }
  sql += " ORDER BY code";
  const rows = db.prepare(sql).all(...params);
  for (const obj of rows) {
    obj.key_results = db
      .prepare("SELECT * FROM key_results WHERE objective_id = ? ORDER BY code")
      .all(obj.id);
  }
  res.json(rows);
});

app.post("/api/objectives", (req, res) => {
  const {
    scope = "project",
    project_id,
    period,
    code,
    title,
    description = "",
    status = "on_track",
  } = req.body;
  if (!period || !code || !title)
    return res.status(400).json({ error: "period, code, title required" });
  if (scope === "project" && !project_id)
    return res
      .status(400)
      .json({ error: "project_id required for project objectives" });
  const info = db
    .prepare(
      `INSERT INTO objectives (scope, project_id, period, code, title, description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(scope, project_id || null, period, code, title, description, status);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get("/api/objectives/:id", (req, res) => {
  const obj = db
    .prepare("SELECT * FROM objectives WHERE id = ?")
    .get(req.params.id);
  if (!obj) return res.status(404).json({ error: "Not found" });
  obj.key_results = db
    .prepare("SELECT * FROM key_results WHERE objective_id = ? ORDER BY code")
    .all(obj.id);
  res.json(obj);
});

app.put("/api/objectives/:id", (req, res) => {
  const row = db
    .prepare("SELECT id FROM objectives WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const fields = [
    "scope",
    "project_id",
    "period",
    "code",
    "title",
    "description",
    "status",
  ];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.json({ success: true });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE objectives SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json({ success: true });
});

app.delete("/api/objectives/:id", (req, res) => {
  db.prepare("DELETE FROM objectives WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Key Results API ──────────────────────────────────────────────

app.get("/api/key-results", (req, res) => {
  let sql = "SELECT * FROM key_results WHERE 1=1";
  const params = [];
  if (req.query.objective_id) {
    sql += " AND objective_id = ?";
    params.push(req.query.objective_id);
  }
  sql += " ORDER BY code";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/key-results", (req, res) => {
  const {
    objective_id,
    code,
    title,
    metric_type = "percent",
    baseline = 0,
    current_value = 0,
    target_value = 100,
    weight = 1,
    confidence_score = "green",
    update_source = "manual",
  } = req.body;
  if (!objective_id || !code || !title)
    return res
      .status(400)
      .json({ error: "objective_id, code, title required" });
  const info = db
    .prepare(
      `INSERT INTO key_results (objective_id, code, title, metric_type, baseline, current_value, target_value, weight, confidence_score, update_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      objective_id,
      code,
      title,
      metric_type,
      baseline,
      current_value,
      target_value,
      weight,
      confidence_score,
      update_source
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put("/api/key-results/:id", (req, res) => {
  const row = db
    .prepare("SELECT id FROM key_results WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const fields = [
    "code",
    "title",
    "metric_type",
    "baseline",
    "target_value",
    "weight",
    "update_source",
    "status",
  ];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.json({ success: true });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE key_results SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json({ success: true });
});

app.post("/api/key-results/:id/update", (req, res) => {
  const kr = db
    .prepare("SELECT * FROM key_results WHERE id = ?")
    .get(req.params.id);
  if (!kr) return res.status(404).json({ error: "Not found" });
  const { value, confidence_score, note = "" } = req.body;
  if (value === undefined)
    return res.status(400).json({ error: "value required" });

  db.prepare(
    `INSERT INTO kr_updates (kr_id, old_value, new_value, confidence_score, note, updated_by)
     VALUES (?, ?, ?, ?, ?, 'dashboard')`
  ).run(kr.id, kr.current_value, value, confidence_score || kr.confidence_score, note);

  const updateParts = [
    "current_value = ?",
    "updated_at = datetime('now')",
  ];
  const updateVals = [value];
  if (confidence_score) {
    updateParts.push("confidence_score = ?");
    updateVals.push(confidence_score);
  }
  updateVals.push(kr.id);
  db.prepare(
    `UPDATE key_results SET ${updateParts.join(", ")} WHERE id = ?`
  ).run(...updateVals);
  res.json({ success: true });
});

app.get("/api/key-results/:id/history", (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM kr_updates WHERE kr_id = ? ORDER BY updated_at DESC"
    )
    .all(req.params.id);
  res.json(rows);
});

app.delete("/api/key-results/:id", (req, res) => {
  db.prepare("DELETE FROM key_results WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Milestones API ───────────────────────────────────────────────

app.get("/api/milestones", (req, res) => {
  let sql = "SELECT * FROM milestones WHERE 1=1";
  const params = [];
  if (req.query.project_id) {
    sql += " AND project_id = ?";
    params.push(req.query.project_id);
  }
  sql += " ORDER BY due_date";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/milestones", (req, res) => {
  const {
    project_id,
    title,
    due_date,
    status = "pending",
    linked_kr_id,
  } = req.body;
  if (!project_id || !title)
    return res.status(400).json({ error: "project_id, title required" });
  const info = db
    .prepare(
      `INSERT INTO milestones (project_id, title, due_date, status, linked_kr_id)
     VALUES (?, ?, ?, ?, ?)`
    )
    .run(project_id, title, due_date || null, status, linked_kr_id || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put("/api/milestones/:id", (req, res) => {
  const row = db
    .prepare("SELECT id FROM milestones WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const fields = ["title", "due_date", "status", "linked_kr_id"];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.json({ success: true });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE milestones SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json({ success: true });
});

app.delete("/api/milestones/:id", (req, res) => {
  db.prepare("DELETE FROM milestones WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Bots API ─────────────────────────────────────────────────────

app.get("/api/bots", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM bots ORDER BY enabled DESC, name")
    .all();
  for (const bot of rows) {
    bot.linked_projects = JSON.parse(bot.linked_projects || "[]");
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status IN ('done','completed','已完成') THEN 1 ELSE 0 END) as completed
         FROM task_snapshots WHERE assignee = ?`
      )
      .get(bot.agent_id);
    bot.task_stats = {
      total: stats?.total || 0,
      completed: stats?.completed || 0,
      pending: (stats?.total || 0) - (stats?.completed || 0),
    };
  }
  res.json(rows);
});

app.post("/api/bots", (req, res) => {
  const {
    agent_id,
    name,
    role = "",
    description = "",
    enabled = 1,
    linked_projects = [],
  } = req.body;
  if (!agent_id || !name)
    return res.status(400).json({ error: "agent_id and name required" });
  try {
    const info = db
      .prepare(
        `INSERT INTO bots (agent_id, name, role, description, enabled, linked_projects)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        agent_id,
        name,
        role,
        description,
        enabled ? 1 : 0,
        JSON.stringify(linked_projects)
      );
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message))
      return res.status(409).json({ error: "agent_id already exists" });
    throw e;
  }
});

app.put("/api/bots/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM bots WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const fields = ["name", "role", "description", "enabled", "linked_projects"];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      const v = req.body[f];
      values.push(
        f === "linked_projects"
          ? JSON.stringify(v)
          : f === "enabled"
            ? v
              ? 1
              : 0
            : v
      );
    }
  }
  if (updates.length === 0) return res.json({ success: true });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE bots SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json({ success: true });
});

app.delete("/api/bots/:id", (req, res) => {
  db.prepare("DELETE FROM bots WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/bots/seed", (req, res) => {
  const { accounts } = req.body;
  if (!Array.isArray(accounts))
    return res.status(400).json({ error: "accounts array required" });

  let created = 0;
  let updated = 0;
  for (const acct of accounts) {
    const existing = db
      .prepare("SELECT id FROM bots WHERE agent_id = ?")
      .get(acct.agent_id);
    if (existing) {
      db.prepare(
        "UPDATE bots SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(acct.bot_name || acct.name || acct.agent_id, existing.id);
      updated++;
    } else {
      db.prepare(
        `INSERT INTO bots (agent_id, name, role, description, enabled)
         VALUES (?, ?, ?, ?, 1)`
      ).run(
        acct.agent_id,
        acct.bot_name || acct.name || acct.agent_id,
        acct.role || "",
        acct.description || ""
      );
      created++;
    }
  }
  res.json({ success: true, created, updated });
});

// ── Project Bot Links API ────────────────────────────────────────

app.get("/api/project-bot-links", (req, res) => {
  let sql = `SELECT pbl.*, p.name as project_name, p.slug as project_slug,
                    b.name as bot_name, b.agent_id
             FROM project_bot_links pbl
             JOIN projects p ON pbl.project_id = p.id
             JOIN bots b ON pbl.bot_id = b.id WHERE 1=1`;
  const params = [];
  if (req.query.project_id) {
    sql += " AND pbl.project_id = ?";
    params.push(req.query.project_id);
  }
  if (req.query.bot_id) {
    sql += " AND pbl.bot_id = ?";
    params.push(req.query.bot_id);
  }
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/project-bot-links", (req, res) => {
  const {
    project_id,
    bot_id,
    responsibility = "",
    contribution_weight = 1,
  } = req.body;
  if (!project_id || !bot_id)
    return res.status(400).json({ error: "project_id and bot_id required" });
  try {
    const info = db
      .prepare(
        `INSERT INTO project_bot_links (project_id, bot_id, responsibility, contribution_weight)
       VALUES (?, ?, ?, ?)`
      )
      .run(project_id, bot_id, responsibility, contribution_weight);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message))
      return res.status(409).json({ error: "link already exists" });
    throw e;
  }
});

app.delete("/api/project-bot-links/:id", (req, res) => {
  db.prepare("DELETE FROM project_bot_links WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Task Snapshots API ───────────────────────────────────────────

app.get("/api/task-snapshots", (req, res) => {
  let sql = "SELECT * FROM task_snapshots WHERE 1=1";
  const params = [];
  if (req.query.project_slug) {
    sql += " AND project_slug = ?";
    params.push(req.query.project_slug);
  }
  if (req.query.status) {
    sql += " AND status = ?";
    params.push(req.query.status);
  }
  sql += " ORDER BY synced_at DESC LIMIT 200";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/task-snapshots/bulk", (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks))
    return res.status(400).json({ error: "tasks array required" });

  db.prepare("DELETE FROM task_snapshots").run();

  const stmt = db.prepare(
    `INSERT INTO task_snapshots (record_id, title, status, priority, project_slug, milestone,
       linked_kr_code, assignee, due_date, estimated_hours, task_type, blocker,
       consecutive_delay_days, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let count = 0;
  const insertMany = db.transaction((rows) => {
    for (const t of rows) {
      stmt.run(
        t.record_id || null,
        t.title || "",
        t.status || "",
        t.priority || "",
        t.project_slug || "",
        t.milestone || "",
        t.linked_kr_code || "",
        t.assignee || "",
        t.due_date || null,
        t.estimated_hours || 0,
        t.task_type || "",
        t.blocker || "",
        t.consecutive_delay_days || 0,
        t.raw_json ? JSON.stringify(t.raw_json) : null
      );
      count++;
    }
  });
  insertMany(tasks);
  res.json({ success: true, count });
});

// ── Feishu Bitable Sync ──────────────────────────────────────────

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";

const HOURS_MAP = {
  "15min": 0.25, "30min": 0.5, "1h": 1, "2h": 2,
  "半天": 4, "全天": 8, "多天": 16,
};

async function getFeishuToken() {
  const resp = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`Feishu auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

async function fetchBitableRecords(token, baseId, tableId) {
  const records = [];
  let pageToken = "";
  const searchUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/search`;
  do {
    const url = new URL(searchUrl);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          conjunction: "and",
          conditions: [
            { field_name: "任务名", operator: "isNotEmpty", value: [] },
          ],
        },
      }),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`Bitable search failed: ${data.msg}`);
    records.push(...(data.data.items || []));
    pageToken = data.data.has_more ? data.data.page_token : "";
  } while (pageToken);
  return records;
}

function textVal(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((seg) => (typeof seg === "object" ? seg.text || "" : String(seg))).join("");
  if (typeof v === "object" && v.text) return v.text;
  return String(v);
}

function mapRecord(rec) {
  const f = rec.fields || {};
  const deadline = f["截止时间"];
  let dueDate = null;
  if (deadline) {
    const ts = typeof deadline === "number" ? deadline : null;
    dueDate = ts ? new Date(ts).toISOString().slice(0, 10) : null;
  }
  return {
    record_id: rec.record_id,
    title: textVal(f["任务名"]),
    status: textVal(f["状态"]),
    priority: textVal(f["优先级"]),
    project_slug: "",
    milestone: "",
    linked_kr_code: textVal(f["关联目标"]),
    assignee: "",
    due_date: dueDate,
    estimated_hours: HOURS_MAP[textVal(f["预估工时"])] || 0,
    task_type: textVal(f["任务类型"]),
    blocker: textVal(f["阻塞谁"]),
    consecutive_delay_days: Number(f["连续拖延天数"]) || 0,
    raw_json: f,
  };
}

async function runSync() {
  const baseId = getSetting("feishu_base_id");
  const tableId = getSetting("feishu_table_id");
  if (!baseId || !tableId) throw new Error("feishu_base_id / feishu_table_id not configured");
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET env vars missing");

  const token = await getFeishuToken();
  const records = await fetchBitableRecords(token, baseId, tableId);
  const tasks = records.map(mapRecord);

  db.prepare("DELETE FROM task_snapshots").run();
  const stmt = db.prepare(
    `INSERT INTO task_snapshots (record_id, title, status, priority, project_slug, milestone,
       linked_kr_code, assignee, due_date, estimated_hours, task_type, blocker,
       consecutive_delay_days, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction((rows) => {
    for (const t of rows) {
      stmt.run(
        t.record_id, t.title, t.status, t.priority, t.project_slug,
        t.milestone, t.linked_kr_code, t.assignee, t.due_date,
        t.estimated_hours, t.task_type, t.blocker,
        t.consecutive_delay_days, t.raw_json ? JSON.stringify(t.raw_json) : null
      );
    }
  });
  insertMany(tasks);
  return tasks.length;
}

// ── Sync Runs API ────────────────────────────────────────────────

app.get("/api/sync/runs", (req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20")
      .all()
  );
});

app.post("/api/sync/trigger", async (req, res) => {
  const run = db
    .prepare(
      "INSERT INTO sync_runs (source, status) VALUES ('feishu_bitable', 'running')"
    )
    .run();
  const runId = run.lastInsertRowid;
  try {
    const count = await runSync();
    db.prepare(
      "UPDATE sync_runs SET status = 'success', ended_at = datetime('now'), records_synced = ? WHERE id = ?"
    ).run(count, runId);
    res.json({ success: true, run_id: runId, records_synced: count });
  } catch (e) {
    db.prepare(
      "UPDATE sync_runs SET status = 'error', ended_at = datetime('now'), error_summary = ? WHERE id = ?"
    ).run(e.message, runId);
    res.status(500).json({ success: false, run_id: runId, error: e.message });
  }
});

// ── Global Blockers API ──────────────────────────────────────────

app.get("/api/blockers", (req, res) => {
  const blockers = db
    .prepare(
      `SELECT * FROM task_snapshots
       WHERE (blocker != '' AND blocker IS NOT NULL)
          OR priority IN ('P0','urgent','紧急')
          OR (due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('done','completed','已完成'))
       ORDER BY
         CASE WHEN priority IN ('P0','urgent','紧急') THEN 0 ELSE 1 END,
         due_date`
    )
    .all();
  res.json(blockers);
});

// ── Decision Log API ─────────────────────────────────────────────

app.get("/api/decision-log", (req, res) => {
  const entries = [];
  try {
    if (!fs.existsSync(DAILY_LOG_DIR)) return res.json(entries);
    const files = fs
      .readdirSync(DAILY_LOG_DIR)
      .filter((f) => f.endsWith(".md") && f.includes("log"))
      .sort()
      .reverse();

    for (const file of files.slice(0, 30)) {
      const content = fs.readFileSync(path.join(DAILY_LOG_DIR, file), "utf-8");
      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
      entries.push({
        date: dateMatch ? dateMatch[1] : file.replace(".md", ""),
        filename: file,
        content: content.substring(0, 5000),
      });
    }
  } catch {
    // daily log dir may not exist yet
  }

  // Also try single daily-log.md file
  const singleLog = path.join(DAILY_LOG_DIR, "daily-log.md");
  if (entries.length === 0 && fs.existsSync(singleLog)) {
    try {
      const content = fs.readFileSync(singleLog, "utf-8");
      const sections = content.split(/^## /m).filter(Boolean);
      for (const section of sections.slice(0, 30)) {
        const firstLine = section.split("\n")[0].trim();
        const dateMatch = firstLine.match(/(\d{4}-\d{2}-\d{2})/);
        entries.push({
          date: dateMatch ? dateMatch[1] : firstLine,
          filename: "daily-log.md",
          content: "## " + section.substring(0, 5000),
        });
      }
    } catch {}
  }

  if (req.query.project) {
    const slug = req.query.project.toLowerCase();
    return res.json(
      entries.filter((e) => e.content.toLowerCase().includes(slug))
    );
  }
  res.json(entries);
});

// ── Overview API ─────────────────────────────────────────────────

app.get("/api/overview", (req, res) => {
  const currentPeriod = getSetting("current_period", "2026-Q2");

  // Project stats
  const projectCounts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
         SUM(CASE WHEN is_focus = 1 THEN 1 ELSE 0 END) as focus
       FROM projects`
    )
    .get();

  // Focus projects with progress
  const focusProjects = db
    .prepare(
      "SELECT * FROM projects WHERE is_focus = 1 AND status = 'active' ORDER BY name"
    )
    .all()
    .map((p) => ({ ...p, progress: computeProjectProgress(p) }));

  // Company OKR summary for current period
  const companyObjs = db
    .prepare(
      "SELECT * FROM objectives WHERE scope = 'company' AND period = ? ORDER BY code"
    )
    .all(currentPeriod);
  for (const obj of companyObjs) {
    obj.key_results = db
      .prepare("SELECT * FROM key_results WHERE objective_id = ? ORDER BY code")
      .all(obj.id);
  }

  // Zombie detection: active projects with 0 completed tasks in last 14 days
  const zombies = db
    .prepare(
      `SELECT p.* FROM projects p
       WHERE p.status = 'active'
         AND p.id NOT IN (
           SELECT DISTINCT pr.id FROM projects pr
           JOIN task_snapshots ts ON ts.project_slug = pr.slug
           WHERE ts.status IN ('done','completed','已完成')
             AND ts.synced_at >= datetime('now', '-14 days')
         )`
    )
    .all();

  // Bot health
  const bots = db
    .prepare("SELECT id, agent_id, name, enabled, last_sync_at FROM bots")
    .all();
  const botHealth = {
    total: bots.length,
    enabled: bots.filter((b) => b.enabled).length,
    disabled: bots.filter((b) => !b.enabled).length,
  };

  // Capacity: rolling 7-day from task_snapshots
  const capacity = computeCapacity();

  // Recent sync
  const lastSync = db
    .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1")
    .get();

  // Blocker count
  const blockerCount =
    db
      .prepare(
        `SELECT COUNT(*) as c FROM task_snapshots
         WHERE (blocker != '' AND blocker IS NOT NULL)
            OR priority IN ('P0','urgent','紧急')
            OR (due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('done','completed','已完成'))`
      )
      .get()?.c || 0;

  // Procrastination top 5
  const procrastinators = db
    .prepare(
      `SELECT title, consecutive_delay_days, project_slug, status
       FROM task_snapshots
       WHERE consecutive_delay_days > 0
       ORDER BY consecutive_delay_days DESC LIMIT 5`
    )
    .all();

  res.json({
    current_period: currentPeriod,
    projects: projectCounts,
    focus_projects: focusProjects,
    company_okrs: companyObjs,
    zombies,
    bot_health: botHealth,
    capacity,
    last_sync: lastSync || null,
    blocker_count: blockerCount,
    procrastinators,
  });
});

// ── Settings API ─────────────────────────────────────────────────

app.get("/api/settings", (req, res) => {
  res.json({
    current_period: getSetting("current_period", "2026-Q2"),
    feishu_base_id: getSetting("feishu_base_id", ""),
    feishu_table_id: getSetting("feishu_table_id", ""),
    dashboard_port: PORT,
  });
});

app.put("/api/settings", (req, res) => {
  const allowed = ["current_period", "feishu_base_id", "feishu_table_id"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setSetting(key, req.body[key]);
  }
  res.json({
    current_period: getSetting("current_period", "2026-Q2"),
    feishu_base_id: getSetting("feishu_base_id", ""),
    feishu_table_id: getSetting("feishu_table_id", ""),
    dashboard_port: PORT,
  });
});

// ── Periods API ──────────────────────────────────────────────────

app.get("/api/periods", (req, res) => {
  const periods = db
    .prepare("SELECT DISTINCT period FROM objectives ORDER BY period DESC")
    .all()
    .map((r) => r.period);
  res.json(periods);
});

// ── Progress Computation ─────────────────────────────────────────

function computeProjectProgress(project) {
  // 50% task completion
  const taskStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status IN ('done','completed','已完成') THEN 1 ELSE 0 END) as completed
       FROM task_snapshots WHERE project_slug = ?`
    )
    .get(project.slug);
  const taskRatio =
    taskStats.total > 0 ? taskStats.completed / taskStats.total : 0;

  // 30% milestone completion
  const msStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed
       FROM milestones WHERE project_id = ?`
    )
    .get(project.id);
  const msRatio = msStats.total > 0 ? msStats.completed / msStats.total : 0;

  // 20% KR health
  const krs = db
    .prepare(
      `SELECT kr.* FROM key_results kr
       JOIN objectives o ON kr.objective_id = o.id
       WHERE o.project_id = ?`
    )
    .all(project.id);
  let krAvg = 0;
  if (krs.length > 0) {
    const totalWeight = krs.reduce((s, kr) => s + kr.weight, 0);
    krAvg =
      krs.reduce((s, kr) => {
        const range = kr.target_value - kr.baseline;
        const pct =
          range > 0 ? (kr.current_value - kr.baseline) / range : 0;
        return s + Math.min(1, Math.max(0, pct)) * kr.weight;
      }, 0) / (totalWeight || 1);
  }

  return Math.round((taskRatio * 0.5 + msRatio * 0.3 + krAvg * 0.2) * 100);
}

function computeCapacity() {
  const deepTypes = new Set([
    "development",
    "design",
    "research",
    "开发",
    "设计",
    "研究",
    "核心",
  ]);
  const tasks = db
    .prepare(
      `SELECT task_type, estimated_hours, status
       FROM task_snapshots
       WHERE synced_at >= datetime('now', '-7 days')`
    )
    .all();

  let deepHours = 0;
  let shallowHours = 0;
  let completedCount = 0;
  let totalCount = tasks.length;

  for (const t of tasks) {
    const hours = t.estimated_hours || 1;
    if (deepTypes.has((t.task_type || "").toLowerCase())) {
      deepHours += hours;
    } else {
      shallowHours += hours;
    }
    if (["done", "completed", "已完成"].includes(t.status)) {
      completedCount++;
    }
  }

  return {
    deep_hours: Math.round(deepHours * 10) / 10,
    shallow_hours: Math.round(shallowHours * 10) / 10,
    total_hours: Math.round((deepHours + shallowHours) * 10) / 10,
    deep_ratio:
      deepHours + shallowHours > 0
        ? Math.round((deepHours / (deepHours + shallowHours)) * 100)
        : 0,
    completed_count: completedCount,
    total_count: totalCount,
  };
}

// ── SPA Fallback ─────────────────────────────────────────────────

app.get("*", (req, res) => {
  if (req.path.startsWith("/api"))
    return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`cyber-boss-dashboard listening on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Daily log dir: ${DAILY_LOG_DIR}`);
});
