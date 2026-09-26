// Map a playwright-cli snapshot onto the roles cua-s1 was trained on.
// The model scores Edit, CheckBox, and Button. Links, radios, and selects stay out.

const ROLE_MAP = {
  textbox: 'Edit',
  searchbox: 'Edit',
  checkbox: 'CheckBox',
  button: 'Button',
};

const APP_SUFFIXES = [
  ' - Google Chrome',
  ' - Microsoft Edge',
  ' - Mozilla Firefox',
  ' - Brave',
  ' - Safari',
];

function normalizeFormTitle(title) {
  for (const suffix of APP_SUFFIXES) {
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
  }
  return title;
}

function unescapeYaml(value) {
  return value.replace(/\\([\\n"])/g, (_, ch) => (ch === 'n' ? '\n' : ch));
}

const SNAPSHOT_LINE =
  /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:\\.|[^"\\])*)")?(?: \[ref=([^\]]+)\])?(?:: "((?:\\.|[^"\\])*)")?(.*)$/;

function elementsFromSnapshot(snapshot) {
  let title = '';
  const elements = [];

  for (const rawLine of snapshot.split('\n')) {
    const titleMatch = /^Page Title:\s*(.*)$/.exec(rawLine.trim());
    if (titleMatch && !title) {
      title = normalizeFormTitle(titleMatch[1].trim());
      continue;
    }

    const match = SNAPSHOT_LINE.exec(rawLine);
    if (!match) continue;
    const role = ROLE_MAP[match[2].toLowerCase()];
    if (!role) continue;

    const label = match[3] ? unescapeYaml(match[3]) : '';
    const token = match[4] || `e${elements.length + 1}`;
    const value = match[5] !== undefined ? unescapeYaml(match[5]) : '';
    const rest = match[6] ?? '';
    const checkedMatch = /\[checked(?:=(true|false))?\]/.exec(rest);
    const element = { role, label, index: elements.length, token };
    if (role === 'CheckBox') {
      element.checked = checkedMatch ? checkedMatch[1] !== 'false' : false;
    } else if (value) {
      element.value = value;
    }
    elements.push(element);
  }

  return { title, elements };
}

module.exports = { normalizeFormTitle, elementsFromSnapshot };
