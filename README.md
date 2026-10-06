# joplin-mcp

MCP server for the local [Joplin](https://joplinapp.org) Web Clipper API, with extra
tools that follow the conventions of the
[joplin-uni](https://github.com/julianrottenberg/joplin-uni) plugin.

Use it from any MCP-capable agent (pi, Claude Code, …) to read and write notes,
and to manage the uni workspace: add courses, readings, deadlines and lecture
notes in the exact shape the plugin's dashboard understands.

## Requirements

- Joplin desktop running, with the **Web Clipper API enabled**
  (Settings → Web Clipper). The server talks to `http://localhost:41184`.
- Node.js ≥ 20.

Auth is automatic: the token is read from
`~/.config/joplin-desktop/settings.json` (`api.token`). Override with the
`JOPLIN_TOKEN` / `JOPLIN_PORT` env vars.

## Install

```bash
npm install
```

Register in pi (user-level, all projects):

```bash
pi mcp add joplin -- node /home/julian/projects/joplin-mcp/src/index.js
```

or add this to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "joplin": {
      "command": "node",
      "args": ["/home/julian/projects/joplin-mcp/src/index.js"],
      "description": "Joplin notes (local Web Clipper API) + joplin-uni workspace helpers",
      "exposure": "direct"
    }
  }
}
```

Run `/reload` in a pi session (or start a new one), then `/mcp` to verify.
The uni notebook defaults to `University`; set env `UNI_NOTEBOOK` to change it.

## Tools

### Generic Joplin (`joplin_*`)

| Tool | Purpose |
|---|---|
| `joplin_ping` | Check the API is reachable |
| `joplin_list_notebooks` | List all notebooks (id, title, parent) |
| `joplin_list_notes` | List notes in a notebook (by title or id) |
| `joplin_get_note` | Full note incl. Markdown body |
| `joplin_search` | Full-text search |
| `joplin_create_notebook` | Create a notebook (optionally nested) |
| `joplin_create_note` | Create a note or to-do |
| `joplin_update_note` | Replace title/body (body is replaced wholesale — fetch first) |
| `joplin_delete_note` | Delete (trash by default, `permanent: true` to skip) |

### Uni workspace (`uni_*`)

These mirror the plugin's structure: the `University` notebook contains one
folder per course with `Vorlesungen`/`Abgaben` subfolders, a `Kursinfo` note
whose top block holds the module details as JSON (the dashboard reads
Status/ECTS from it), and a `Literaturliste` with `## Woche N` sections.

| Tool | Purpose |
|---|---|
| `uni_add_course` | New course with full structure (idempotent) |
| `uni_update_course_details` | Edit the Kursinfo details block; user content below is preserved |
| `uni_add_reading` | Append `- [ ] **Priorität** · Text` to a Woche section (week 0 = Weiterführende Literatur) |
| `uni_add_deadline` | To-do in Abgaben, due 08:00 on the date (TT.MM.JJJJ or ISO) |
| `uni_add_lecture_note` | "Woche N — Thema" note in Vorlesungen |

Field vocabulary (matches the plugin):
`status`: `Pflichtmodul`/`Wahlpflichtmodul` (or `mandatory`/`elective`),
`turnus`: `winter`/`summer`/`both`,
priorities: `Essenziell`/`Empfohlen`/`Optional`,
deadline types: `Abgabe`, `Prüfung`, `Präsentation`, `Essay`, `Lektüre`, `Termin`, `Sonstiges`.

After uni_* writes, refresh the dashboard in Joplin once:
Strg+Umschalt+P → „Uni: Dashboard aktualisieren" (it also refreshes on
Joplin start when that setting is on).

## Security notes

- Localhost only: the Web Clipper API binds to 127.0.0.1.
- The token grants full access to your Joplin data; keep it out of commits.
  This repo never stores it — it is read from Joplin's own settings at runtime.
- Writes happen only through explicit tool calls; `uni_*` tools never delete,
  and `joplin_delete_note` uses the trash unless asked otherwise.
