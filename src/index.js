#!/usr/bin/env node
// joplin-mcp: MCP server over the local Joplin Web Clipper API.
//
// Two tool families:
//   joplin_*  — generic CRUD over notebooks and notes
//   uni_*     — helpers that follow the joplin-uni plugin's conventions, so
//               courses/readings/deadlines added here show up correctly on
//               the plugin's dashboard
//
// Transport: stdio. Auth: reads the Web Clipper token from Joplin's
// settings.json (or JOPLIN_TOKEN / JOPLIN_PORT env vars). Joplin desktop
// must be running for any call to succeed.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as joplin from './joplin.js';
import * as uni from './uni.js';

const server = new McpServer(
	{ name: 'joplin', version: '0.1.0' },
	{
		instructions:
			'Joplin notes via the local Web Clipper API (Joplin desktop must be running). ' +
			'The uni_* tools manage a university workspace that mirrors the joplin-uni plugin: ' +
			'courses live in the "University" notebook (override with UNI_NOTEBOOK), each with ' +
			'Vorlesungen/Abgaben subfolders, a Kursinfo note with a machine-readable details block, ' +
			'and a Literaturliste with Woche sections. Prefer uni_* tools for anything course-related; ' +
			'use joplin_* for everything else.',
	},
);

function respond(value) {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function guard(handler) {
	return async (args) => {
		try {
			return respond(await handler(args));
		} catch (error) {
			return {
				isError: true,
				content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
			};
		}
	};
}

const notebookRef = z.string().describe('Notebook title (exact) or notebook id');
const courseRef = z.string().describe('Course title, or a unique substring of it (case-insensitive)');
const courseDetailsShape = {
	code: z.string().optional().describe('Module code, e.g. "M-FE"'),
	status: z.string().optional().describe('"Pflichtmodul"/"Wahlpflichtmodul" or "mandatory"/"elective"'),
	ects: z.string().optional().describe('Credits, e.g. "9"'),
	sws: z.string().optional().describe('Contact hours per week, e.g. "4"'),
	turnus: z.string().optional().describe('"winter", "summer" or "both"'),
	exam: z.string().optional().describe('Assessment (Prüfungsleistung), free text'),
	instructor: z.string().optional().describe('Dozent:in, free text'),
	semester: z.string().optional().describe('Semester taken, e.g. "WiSe 2026/27"'),
};

// --------------------------------------------------------------------------
// Generic Joplin tools
// --------------------------------------------------------------------------

server.registerTool('joplin_ping', {
	description: 'Check whether the Joplin Web Clipper API is reachable.',
	annotations: { readOnlyHint: true },
}, guard(async () => ({ result: await joplin.ping() })));

server.registerTool('joplin_list_notebooks', {
	description: 'List all Joplin notebooks (id, title, parent_id).',
	annotations: { readOnlyHint: true },
}, guard(async () => {
	const folders = await joplin.listFolders();
	return { notebooks: folders.map(({ id, title, parent_id }) => ({ id, title, parent_id })) };
}));

server.registerTool('joplin_list_notes', {
	description: 'List notes inside one notebook.',
	inputSchema: { notebook: notebookRef },
	annotations: { readOnlyHint: true },
}, guard(async ({ notebook }) => {
	const folder = await resolveNotebook(notebook);
	return { notebook: folder.title, notes: await joplin.listNotesInFolder(folder.id) };
}));

server.registerTool('joplin_get_note', {
	description: 'Get one note with its full Markdown body.',
	inputSchema: { id: z.string().describe('Note id') },
	annotations: { readOnlyHint: true },
}, guard(async ({ id }) => joplin.getNote(id)));

server.registerTool('joplin_search', {
	description: 'Full-text search over all notes.',
	inputSchema: { query: z.string() },
	annotations: { readOnlyHint: true },
}, guard(async ({ query }) => ({ notes: await joplin.searchNotes(query) })));

server.registerTool('joplin_create_notebook', {
	description: 'Create a notebook, optionally nested inside another one.',
	inputSchema: { title: z.string(), parent: notebookRef.optional().describe('Parent notebook title or id; omit for top level') },
}, guard(async ({ title, parent }) => {
	const parentId = parent ? (await resolveNotebook(parent)).id : '';
	return joplin.createFolder(title, parentId);
}));

server.registerTool('joplin_create_note', {
	description: 'Create a note (or to-do when is_todo is set) in a notebook.',
	inputSchema: {
		notebook: notebookRef,
		title: z.string(),
		body: z.string().optional(),
		is_todo: z.boolean().optional(),
		todo_due: z.number().optional().describe('Due date as Unix epoch ms'),
	},
}, guard(async ({ notebook, title, body, is_todo, todo_due }) => {
	const folder = await resolveNotebook(notebook);
	return joplin.createNote({
		title,
		body: body || '',
		parent_id: folder.id,
		is_todo: is_todo ? 1 : 0,
		...(todo_due ? { todo_due } : {}),
	});
}));

server.registerTool('joplin_update_note', {
	description: 'Replace a note\'s title and/or body. The body is replaced wholesale — fetch it first and include the parts you want to keep.',
	inputSchema: {
		id: z.string(),
		title: z.string().optional(),
		body: z.string().optional(),
	},
}, guard(async ({ id, title, body }) => {
	const patch = {};
	if (title !== undefined) patch.title = title;
	if (body !== undefined) patch.body = body;
	await joplin.updateNote(id, patch);
	return { id, updated: Object.keys(patch) };
}));

server.registerTool('joplin_delete_note', {
	description: 'Delete a note. Moves to Joplin\'s trash unless permanent is true.',
	inputSchema: {
		id: z.string(),
		permanent: z.boolean().optional().describe('Skip the trash and delete for good'),
	},
	annotations: { destructiveHint: true },
}, guard(async ({ id, permanent }) => {
	await joplin.deleteNote(id, permanent === true);
	return { id, deleted: true, permanent: permanent === true };
}));

// --------------------------------------------------------------------------
// Uni-workspace tools (joplin-uni conventions)
// --------------------------------------------------------------------------

server.registerTool('uni_add_course', {
	description:
		'Add a course to the uni workspace: creates the course notebook with Vorlesungen/Abgaben ' +
		'subfolders, a Kursinfo note (managed details block, readable by the joplin-uni dashboard) ' +
		'and a Literaturliste with Woche sections. Idempotent — existing folders/notes are kept.',
	inputSchema: {
		name: z.string().describe('Course name, e.g. "Persönlichkeit und Diagnostik"'),
		...courseDetailsShape,
	},
}, guard(async (input) => uni.addCourse(input)));

server.registerTool('uni_update_course_details', {
	description:
		'Update the managed details block of a course\'s Kursinfo note (code, status, ECTS, SWS, ' +
		'turnus, exam, instructor, semester). Only the given fields change; user-written content ' +
		'below the block is preserved.',
	inputSchema: {
		course: courseRef,
		...courseDetailsShape,
	},
}, guard(async ({ course, ...patch }) => uni.updateCourseDetails(course, patch)));

server.registerTool('uni_add_reading', {
	description:
		'Append a reading item to a course\'s Literaturliste under its Woche section ' +
		'(week 0 or omitted = Weiterführende Literatur). Shows up in the dashboard\'s reading progress.',
	inputSchema: {
		course: courseRef,
		text: z.string().describe('The reading, e.g. "Gettier (1963) — Is Justified True Belief Knowledge?, S. 121–123"'),
		week: z.number().int().min(0).optional().describe('Week number; 0 = further reading'),
		priority: z.enum(uni.READING_PRIORITIES).optional().describe('Default: Empfohlen'),
	},
}, guard(async ({ course, ...rest }) => uni.addReading(course, rest)));

server.registerTool('uni_add_deadline', {
	description:
		'Add a deadline to a course: creates a to-do in its Abgaben folder, titled "{type}: {title}", ' +
		'due at 08:00 on the given date. Appears on the dashboard\'s deadline list.',
	inputSchema: {
		course: courseRef,
		type: z.string().describe(`e.g. ${uni.DEADLINE_TYPES.slice(0, 3).join(', ')}`),
		due: z.string().describe('Due date as TT.MM.JJJJ or JJJJ-MM-TT'),
		title: z.string(),
	},
}, guard(async ({ course, ...rest }) => uni.addDeadline(course, rest)));

server.registerTool('uni_add_lecture_note', {
	description: 'Create a lecture note ("Woche N — Thema") in a course\'s Vorlesungen folder.',
	inputSchema: {
		course: courseRef,
		week: z.number().int().min(1),
		topic: z.string(),
		date: z.string().optional().describe('Free text, e.g. "12.10.2026"'),
	},
}, guard(async ({ course, ...rest }) => uni.addLectureNote(course, rest)));

// --------------------------------------------------------------------------

async function resolveNotebook(ref) {
	const folders = await joplin.listFolders();
	const folder = folders.find((f) => f.id === ref) || folders.find((f) => f.title === ref);
	if (!folder) throw new Error(`Notebook "${ref}" nicht gefunden.`);
	return folder;
}

await server.connect(new StdioServerTransport());
