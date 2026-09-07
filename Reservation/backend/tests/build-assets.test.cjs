const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('Given email templates, when packaging from another working directory, then ship identical files and replace stale copies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reservation-email-assets-'));
  try {
    const script = path.join(root, 'scripts/copy-email-templates.mjs');
    const source = path.join(root, 'src/notification/templates');
    const destination = path.join(root, 'dist/notification/templates');
    await mkdir(path.dirname(script), { recursive: true });
    await cp(path.join(__dirname, '../scripts/copy-email-templates.mjs'), script);
    await cp(path.join(__dirname, '../src/notification/templates'), source, { recursive: true });
    const names = (await readdir(source)).sort();
    assert(names.length > 0);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, names[0]), Buffer.from([0]));

    execFileSync(process.execPath, [script], { cwd: tmpdir(), timeout: 5000, stdio: 'pipe' });

    assert.deepEqual((await readdir(destination)).sort(), names);
    for (const name of names) {
      assert.deepEqual(await readFile(path.join(destination, name)), await readFile(path.join(source, name)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
