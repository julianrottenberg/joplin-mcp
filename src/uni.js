// Uni-workspace helpers: mirror the conventions of the joplin-uni plugin
// (https://github.com/julianrottenberg/joplin-uni) so notes written here are
// understood by the plugin's dashboard — and vice versa.
//
// Conventions replicated here (German, matching the plugin's 'de' language):
//   - one top-level notebook (default "University")
//   - one folder per course, containing the subfolders "Vorlesungen" and
//     "Abgaben" plus the notes "Kursinfo" and "Literaturliste"
//   - Kursinfo starts with a managed block: an HTML comment holding the
//     module details as JSON, a heading, visible field lines, and a closing
//     comment. Everything after the closing comment is user content.
//   - Literaturliste has "## Woche N" sections plus "## Weiterführende
//     Literatur"; items are Markdown checkboxes `- [ ] **Priorität** · Text`
//   - deadlines are to-do notes in "Abgaben" titled "{Typ}: {Titel}" with
//     todo_due set to 08:00 on the due date

import {
	createFolder,
	createNote,
	getNote,
	listFolders,
	listNotesInFolder,
	updateNote,
} from './joplin.js';

const NOTEBOOK = process.env.UNI_NOTEBOOK || 'University';

export const BLOCK_START = '<!-- uni-course:';
export const BLOCK_END = '<!-- /uni-course -->';

const STATUS_LABELS = { mandatory: 'Pflichtmodul', elective: 'Wahlpflichtmodul' };
const STATUS_VALUES = {
	mandatory: 'mandatory', pflichtmodul: 'mandatory',
	elective: 'elective', wahlpflichtmodul: 'elective',
};
const TURNUS_LABELS = {
	winter: 'Wintersemester',
	summer: 'Sommersemester',
	both: 'Winter- und Sommersemester',
};
export const DEADLINE_TYPES = ['Abgabe', 'Prüfung', 'Präsentation', 'Essay', 'Lektüre', 'Termin', 'Sonstiges'];
export const READING_PRIORITIES = ['Essenziell', 'Empfohlen', 'Optional'];

const DETAIL_KEYS = ['code', 'status', 'ects', 'sws', 'turnus', 'exam', 'instructor', 'semester'];

export function emptyDetails() {
	return Object.fromEntries(DETAIL_KEYS.map((key) => [key, '']));
}

function sanitizeDetails(raw) {
	const details = emptyDetails();
	for (const key of DETAIL_KEYS) {
		const value = raw && typeof raw[key] === 'string' ? raw[key].trim() : '';
		if (key === 'status') {
			details.status = STATUS_VALUES[value.toLowerCase()] || '';
		} else if (key === 'turnus') {
			details.turnus = ['winter', 'summer', 'both'].includes(value) ? value : '';
		} else {
			details[key] = value.replace(/-->/g, '→');
		}
	}
	return details;
}

/** Parse a Kursinfo body into { details, userContent }. */
export function parseCourseInfo(body) {
	const raw = body || '';
	const start = raw.indexOf(BLOCK_START);
	if (start < 0) {
		return { details: emptyDetails(), userContent: raw };
	}
	const jsonEnd = raw.indexOf('-->', start);
	let details = emptyDetails();
	if (jsonEnd > start) {
		try {
			details = sanitizeDetails(JSON.parse(raw.slice(start + BLOCK_START.length, jsonEnd)));
		} catch {
			// Corrupt JSON: regenerate the block from empty details, keep user content.
		}
	}
	const end = raw.indexOf(BLOCK_END, start);
	const userContent = end >= 0
		? raw.slice(end + BLOCK_END.length).replace(/^(\s*\n)+/, '')
		: '';
	return { details, userContent };
}

/** Render the managed block (JSON comment, heading, visible fields). */
export function renderCourseInfoBlock(name, details) {
	const fields = [];
	const push = (label, value) => {
		if (value) fields.push(`- **${label}:** ${value}`);
	};
	push('Status', STATUS_LABELS[details.status] || '');
	push('ECTS', details.ects);
	push('SWS', details.sws);
	push('Turnus', TURNUS_LABELS[details.turnus] || '');
	push('Prüfungsleistung', details.exam);
	push('Nummer', details.code);
	push('Dozent:in', details.instructor);
	push('Semester', details.semester);
	return [
		`${BLOCK_START}${JSON.stringify(details)} -->`,
		`# ${name}`,
		...fields,
		BLOCK_END,
	].join('\n');
}

/** Full Kursinfo body for a freshly created course. */
export function courseInfoBody(name, details) {
	return `${renderCourseInfoBlock(name, details)}\n\n## Zeitplan\n\n## Benotung\n\n## Links\n`;
}

export function readingListBody(courseName, weeks = 14) {
	const parts = [
		`# ${courseName} — Literaturliste`,
		'',
		'Hake Einträge ab, sobald du sie gelesen hast — der Fortschritt erscheint im Uni-Dashboard. '
			+ 'Einträge ergänzt du über die Befehlspalette (Strg+Umschalt+P, „Uni: Lesetext hinzufügen…") '
			+ 'oder direkt als Markdown-Checkboxen.',
	];
	for (let week = 1; week <= weeks; week++) parts.push('', `## Woche ${week}`);
	parts.push('', '## Weiterführende Literatur', '');
	return parts.join('\n');
}

const weekHeadingRe = (week) => new RegExp(`^#{1,6}\\s*(?:Week|Woche)\\s*${week}\\b`, 'i');
const FURTHER_RE = /^#{1,6}\s*(?:Further\s+reading|Weiterf(?:ü|ue)hrende\s+Literatur)\b/i;

/** Insert a reading line under its week heading (null/0 → Weiterführende Literatur). */
export function insertReadingLine(body, line, week) {
	const lines = (body || '').split(/\r?\n/);
	let headingIdx = -1;
	if (week) {
		headingIdx = lines.findIndex((l) => weekHeadingRe(week).test(l));
		if (headingIdx < 0) {
			const frIdx = lines.findIndex((l) => FURTHER_RE.test(l));
			lines.splice(frIdx >= 0 ? frIdx : lines.length, 0, `## Woche ${week}`);
			headingIdx = lines.findIndex((l) => weekHeadingRe(week).test(l));
		}
	} else {
		headingIdx = lines.findIndex((l) => FURTHER_RE.test(l));
		if (headingIdx < 0) {
			lines.push('', '## Weiterführende Literatur');
			headingIdx = lines.length - 1;
		}
	}
	let sectionEnd = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			sectionEnd = i;
			break;
		}
	}
	let insertAt = sectionEnd;
	while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
	lines.splice(insertAt, 0, line);
	return lines.join('\n');
}

/** Parse "DD.MM.YYYY" or "YYYY-MM-DD" into ms at 08:00 local time. */
export function dateInputToMs(input, hour = 8) {
	const german = input.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
	const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	let year, month, day;
	if (german) {
		[, day, month, year] = german;
	} else if (iso) {
		[, year, month, day] = iso;
	} else {
		throw new Error(`Ungültiges Datum: "${input}" — bitte TT.MM.JJJJ oder JJJJ-MM-TT.`);
	}
	const date = new Date(Number(year), Number(month) - 1, Number(day), hour, 0, 0, 0);
	if (Number.isNaN(date.getTime())) throw new Error(`Ungültiges Datum: "${input}".`);
	return date.getTime();
}

export function lectureBody(courseName, week, date, topic) {
	return [
		`# ${courseName} — Woche ${week}${topic ? `: ${topic}` : ''}`,
		'',
		`*Datum: ${date || '—'}*`,
		'',
		'## Notizen',
		'',
		'## Kernpunkte',
		'',
		'## Offene Fragen',
		'',
		'## Aufgaben',
		'',
		'- [ ] Die Lektüre dieser Woche durchgehen',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Workspace lookups
// ---------------------------------------------------------------------------

/** The top-level uni notebook folder, or null. */
export async function findUniNotebook() {
	const folders = await listFolders();
	return folders.find((f) => f.title === NOTEBOOK && !f.parent_id) || null;
}

/**
 * Find a course folder by title. Accepts an exact title or a unique
 * case-insensitive substring. Throws with a candidate list when ambiguous.
 */
export async function findCourse(courseRef) {
	const uni = await findUniNotebook();
	if (!uni) throw new Error(`Kein Notizbuch "${NOTEBOOK}" gefunden.`);
	const folders = await listFolders();
	const courses = folders.filter((f) => f.parent_id === uni.id);
	const exact = courses.find((f) => f.title === courseRef);
	if (exact) return exact;
	const matches = courses.filter((f) => f.title.toLowerCase().includes(courseRef.toLowerCase()));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(
			`"${courseRef}" ist nicht eindeutig: ${matches.map((m) => `"${m.title}"`).join(', ')}`,
		);
	}
	throw new Error(
		`Kurs "${courseRef}" nicht gefunden. Vorhanden: ${courses.map((c) => `"${c.title}"`).join(', ') || '(keine)'}`,
	);
}

/** Find or create a child folder by title. */
export async function ensureFolder(parentId, title) {
	const folders = await listFolders();
	const existing = folders.find((f) => f.title === title && f.parent_id === parentId);
	if (existing) return existing;
	return createFolder(title, parentId);
}

/** Find a note by title inside a folder, or null. */
export async function findNote(folderId, title) {
	const notes = await listNotesInFolder(folderId);
	return notes.find((n) => n.title === title) || null;
}

// ---------------------------------------------------------------------------
// Uni operations (called by the MCP tools)
// ---------------------------------------------------------------------------

export async function addCourse(input) {
	const uni = (await findUniNotebook()) || (await createFolder(NOTEBOOK, ''));
	const course = await ensureFolder(uni.id, input.name);
	await ensureFolder(course.id, 'Vorlesungen');
	await ensureFolder(course.id, 'Abgaben');

	const details = sanitizeDetails({
		code: input.code,
		status: input.status,
		ects: input.ects,
		sws: input.sws,
		turnus: input.turnus,
		exam: input.exam,
		instructor: input.instructor,
		semester: input.semester,
	});
	const created = [];
	if (!(await findNote(course.id, 'Kursinfo'))) {
		await createNote({ title: 'Kursinfo', body: courseInfoBody(input.name, details), parent_id: course.id });
		created.push('Kursinfo');
	}
	if (!(await findNote(course.id, 'Literaturliste'))) {
		await createNote({ title: 'Literaturliste', body: readingListBody(input.name), parent_id: course.id });
		created.push('Literaturliste');
	}
	return { courseId: course.id, created };
}

export async function updateCourseDetails(courseRef, patch) {
	const course = await findCourse(courseRef);
	const info = await findNote(course.id, 'Kursinfo');
	if (!info) throw new Error(`Keine Kursinfo-Notiz in "${course.title}".`);
	const note = await getNote(info.id, 'id,body');
	const { details, userContent } = parseCourseInfo(note.body);
	const merged = sanitizeDetails({ ...details, ...patch });
	const body = renderCourseInfoBlock(course.title, merged) + (userContent ? `\n\n${userContent}` : '\n');
	await updateNote(info.id, { body });
	return { courseId: course.id, details: merged };
}

export async function addReading(courseRef, { text, week, priority }) {
	const course = await findCourse(courseRef);
	let note = await findNote(course.id, 'Literaturliste');
	if (!note) {
		note = await createNote({
			title: 'Literaturliste',
			body: readingListBody(course.title),
			parent_id: course.id,
		});
	}
	const { body } = await getNote(note.id, 'id,body');
	const line = `- [ ] **${priority || 'Empfohlen'}** · ${text}`;
	const updated = insertReadingLine(body || '', line, week || 0);
	await updateNote(note.id, { body: updated });
	return { noteId: note.id, week: week || 0 };
}

export async function addDeadline(courseRef, { type, due, title }) {
	const course = await findCourse(courseRef);
	const assignments = await ensureFolder(course.id, 'Abgaben');
	const fullTitle = `${type}: ${title}`;
	const todo = await createNote({
		title: fullTitle,
		body: fullTitle,
		parent_id: assignments.id,
		is_todo: 1,
		todo_due: dateInputToMs(due, 8),
	});
	return { noteId: todo.id, title: fullTitle };
}

export async function addLectureNote(courseRef, { week, topic, date }) {
	const course = await findCourse(courseRef);
	const lectures = await ensureFolder(course.id, 'Vorlesungen');
	const title = `Woche ${week} — ${topic}`;
	const note = await createNote({
		title,
		body: lectureBody(course.title, week, date, topic),
		parent_id: lectures.id,
	});
	return { noteId: note.id, title };
}
