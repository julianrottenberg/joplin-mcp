// Thin wrapper over the Joplin Web Clipper API.
// Base URL is loopback-only. Credentials are resolved lazily on the first API
// call (never at import time, so the MCP handshake works even before auth is
// configured), from JOPLIN_TOKEN / JOPLIN_PORT or from a Joplin settings.json —
// desktop profile (~/.config/joplin-desktop) or CLI profile (~/.config/joplin).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cachedAuth = null;

function settingsCandidates() {
	return [
		join(homedir(), '.config', 'joplin-desktop', 'settings.json'),
		join(homedir(), '.config', 'joplin', 'settings.json'),
	];
}

function loadAuth() {
	if (process.env.JOPLIN_TOKEN) {
		return { token: process.env.JOPLIN_TOKEN, port: Number(process.env.JOPLIN_PORT || 41184) };
	}
	for (const path of settingsCandidates()) {
		try {
			const settings = JSON.parse(readFileSync(path, 'utf8'));
			if (settings['api.token']) {
				return { token: settings['api.token'], port: Number(settings['api.port'] || 41184) };
			}
		} catch {
			// Missing or unreadable profile — try the next candidate.
		}
	}
	throw new Error(
		'joplin-mcp: no Web Clipper credentials found. Set JOPLIN_TOKEN (and optionally ' +
		'JOPLIN_PORT), or enable the Web Clipper API in Joplin. Checked: ' +
		settingsCandidates().join(', '),
	);
}

function auth() {
	if (!cachedAuth) cachedAuth = loadAuth();
	return cachedAuth;
}

export async function api(method, path, body = null, params = {}) {
	const { token, port } = auth();
	const query = new URLSearchParams({ token, ...params });
	let url;
	try {
		url = new URL(`http://localhost:${port}${path}`);
	} catch (cause) {
		throw new Error(`joplin-mcp: could not build request URL for ${path}: ${cause?.message ?? cause}`);
	}
	url.search = query.toString();
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch (cause) {
		throw new Error(
			`Joplin Web Clipper API not reachable on localhost:${port} — is Joplin running ` +
			`(desktop app, or \`joplin server start\` for the CLI)? Cause: ${cause?.message ?? cause}`,
		);
	}
	if (!res.ok) {
		throw new Error(`Joplin API ${method} ${path} failed: ${res.status} ${await res.text()}`);
	}
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`Joplin API ${method} ${path} returned invalid JSON (${text.length} chars)`);
	}
}

export async function apiPaged(path, params = {}) {
	const items = [];
	let page = 1;
	for (;;) {
		const res = await api('GET', path, null, { ...params, page, limit: 100 });
		items.push(...(res.items || []));
		if (!res.has_more) return items;
		page++;
	}
}

export function ping() {
	return api('GET', '/ping');
}

export function listFolders() {
	return apiPaged('/folders', { fields: 'id,title,parent_id' });
}

export function listNotesInFolder(folderId) {
	return apiPaged(`/folders/${folderId}/notes`, { fields: 'id,title,parent_id,updated_time' });
}

export function getNote(id) {
	return api('GET', `/notes/${id}`, null, { fields: 'id,title,body,parent_id,updated_time' });
}

export function searchNotes(query) {
	return apiPaged('/search', { query, type: 'note', fields: 'id,title,parent_id,updated_time' });
}

export function createFolder(title, parentId = '') {
	return api('POST', '/folders', { title, parent_id: parentId });
}

export function createNote(fields) {
	return api('POST', '/notes', fields);
}

export function updateNote(id, patch) {
	return api('PUT', `/notes/${id}`, patch);
}

export function deleteNote(id, permanent = false) {
	return api('DELETE', `/notes/${id}`, null, { permanent: permanent ? 1 : 0 });
}
