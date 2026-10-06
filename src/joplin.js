// Client for the Joplin Web Clipper API (the local REST API Joplin desktop
// exposes while it is running). Zero dependencies: uses global fetch.
//
// Auth: every request carries the API token as a `?token=` query parameter.
// The token is read from JOPLIN_TOKEN, falling back to
// ~/.config/joplin-desktop/settings.json (key "api.token"). The port comes
// from JOPLIN_PORT, then "api.port" in that file, then the default 41184.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadAuth() {
	let token = process.env.JOPLIN_TOKEN || '';
	let port = Number(process.env.JOPLIN_PORT || 0);
	if (!token || !port) {
		const settingsPath = join(homedir(), '.config', 'joplin-desktop', 'settings.json');
		try {
			const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
			token = token || settings['api.token'];
			port = port || Number(settings['api.port'] || 41184);
		} catch (error) {
			throw new Error(
				`joplin-mcp: cannot read token/port from ${settingsPath} (${error.message}). ` +
				'Set JOPLIN_TOKEN and JOPLIN_PORT instead, or enable the Web Clipper API in Joplin.',
			);
		}
	}
	return { token, port };
}

const { token, port } = loadAuth();
const BASE = `http://localhost:${port}`;

export async function api(method, path, { body, params } = {}) {
	const url = new URL(BASE + path); // BASE is a fixed localhost URL built from a validated port
	url.searchParams.set('token', token);
	for (const [key, value] of Object.entries(params || {})) {
		if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	}
	const res = await fetch(url, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Joplin API ${method} ${path} failed: ${res.status} ${text}`.trim());
	}
	const text = await res.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Joplin API ${method} ${path} returned invalid JSON: ${text.slice(0, 200)}`);
	}
}

export async function apiPaged(path, params = {}) {
	const items = [];
	let page = 1;
	for (;;) {
		const res = await api('GET', path, { params: { ...params, page, limit: 100 } });
		items.push(...(res.items || []));
		if (!res.has_more) return items;
		page += 1;
	}
}

export function ping() {
	return api('GET', '/ping');
}

export function listFolders() {
	return apiPaged('/folders', { fields: 'id,title,parent_id' });
}

export function listNotesInFolder(folderId) {
	return apiPaged(`/folders/${folderId}/notes`, {
		fields: 'id,title,is_todo,todo_due,todo_completed,updated_time',
	});
}

export function getNote(id, fields = 'id,title,body,parent_id,is_todo,todo_due,todo_completed,updated_time') {
	return api('GET', `/notes/${id}`, { params: { fields } });
}

export function searchNotes(query) {
	return apiPaged('/search', { query, type: 'note', fields: 'id,title,parent_id,updated_time' });
}

export function createFolder(title, parentId = '') {
	return api('POST', '/folders', { body: { title, parent_id: parentId } });
}

export function createNote(note) {
	return api('POST', '/notes', { body: note });
}

export function updateNote(id, patch) {
	return api('PUT', `/notes/${id}`, { body: patch });
}

export function deleteNote(id, permanent = false) {
	return api('DELETE', `/notes/${id}`, { params: { permanent: permanent ? 1 : 0 } });
}
