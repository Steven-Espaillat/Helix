const { chromium } = require('/Users/perk/src/Helix-dh8/steven/helix-prototypes/frontend/node_modules/playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
await p.goto('http://127.0.0.1:19435/'); await p.getByTestId('review-stage').waitFor({ timeout: 60000 }); await p.waitForTimeout(1500);
const out = {};
for (const id of ['export-disabled-reason','export-package-disabled-reason']) { const l = p.getByTestId(id); if (!(await l.count())) continue;
 await l.evaluate(n => n.scrollIntoView({ block: 'end' })); await p.waitForTimeout(300);
 const r = await l.boundingBox(), d = await p.getByTestId('chat-dock').boundingBox();
 out[id] = { reasonBottom: r.y + r.height, dockTop: d.y, clear: r.y + r.height <= d.y };
 await p.screenshot({ path: `${process.argv[2]}-1024-${id}-scrolled-end.png` }); }
console.log(JSON.stringify(out)); await b.close(); })();
