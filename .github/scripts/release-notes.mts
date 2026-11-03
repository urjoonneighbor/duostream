// Описание релиза из CHANGELOG.md: верхний раздел без записей, которые уже были в описании прошлого релиза.
// Так релиз не повторяет старое, даже если раздел «Следующая версия» после прошлого релиза не переименовали.
//
//   node .github/scripts/release-notes.mts CHANGELOG.md <описание прошлого релиза.md | -> <результат.md>
import fs from 'node:fs';

const [changelogPath, previousPath, outPath] = process.argv.slice(2);
if (!changelogPath || !previousPath || !outPath) {
  console.error('использование: release-notes.mts CHANGELOG.md <прошлое описание | -> <результат>');
  process.exit(2);
}

const lines = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
const start = lines.findIndex((l) => l.startsWith('## '));
if (start < 0) throw new Error('В CHANGELOG.md нет ни одного раздела «## …»');
const endIndex = lines.findIndex((l, i) => i > start && l.startsWith('## '));
const section = lines.slice(start + 1, endIndex < 0 ? lines.length : endIndex);

const previous = previousPath !== '-' && fs.existsSync(previousPath) ? fs.readFileSync(previousPath, 'utf8').replace(/\r\n/g, '\n') : '';
/** Запись уже была: её первая строка (без маркера списка) есть в прошлом описании */
const wasReleased = (block: string[]) => previous.includes(block[0]!.replace(/^- /, '').trim());

// Раздел → подзаголовки «### …» с записями «- …» (продолжение записи — строки с отступом)
const groups: { heading: string | null; blocks: string[][] }[] = [{ heading: null, blocks: [] }];
let block: string[] | null = null;
for (const line of section) {
  if (line.startsWith('### ')) {
    groups.push({ heading: line, blocks: [] });
    block = null;
  } else if (line.startsWith('- ')) {
    block = [line];
    groups.at(-1)!.blocks.push(block);
  } else if (block && line.startsWith('  ')) {
    block.push(line);
  } else {
    block = null;
  }
}

const out: string[] = [];
let kept = 0;
for (const { heading, blocks } of groups) {
  const fresh = blocks.filter((b) => !wasReleased(b));
  if (!fresh.length) continue;
  kept += fresh.length;
  if (heading) out.push(heading);
  for (const b of fresh) out.push(...b);
  out.push('');
}

const notes = kept ? out.join('\n').trim() : 'Мелкие исправления и улучшения.';
fs.writeFileSync(outPath, `${notes}\n`, 'utf8');
console.log(`записей в описании: ${kept} (уже были в прошлом релизе: ${groups.reduce((n, g) => n + g.blocks.length, 0) - kept})`);
