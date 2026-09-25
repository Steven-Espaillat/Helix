// DH-8 evidence: screenshot Gate 3 export affordances. argv: outPrefix width
const { chromium } = require('/Users/perk/src/Helix-dh8/steven/helix-prototypes/frontend/node_modules/playwright');
const [out, width] = [process.argv[2], Number(process.argv[3] || 1440)];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width, height: 900 } });
  const reqs = [];
  p.on('request', r => { if (/\/exports\/|artifacts\//.test(r.url())) reqs.push(r.method() + ' ' + r.url()); });
  await p.goto('http://127.0.0.1:19435/');
  await p.getByTestId('review-stage').waitFor({ timeout: 60000 });
  await p.waitForTimeout(2500);
  const q = async (sel) => p.locator(sel).count();
  const facts = {
    stage: await p.getByTestId('stage-view').getAttribute('data-selected-stage'),
    exportFinal: await p.getByTestId('export-final-package').count() ? { enabled: await p.getByTestId('export-final-package').isEnabled(), text: (await p.getByTestId('export-final-package').innerText()).trim() } : null,
    exportPackage: await p.getByTestId('export-package').count() ? { enabled: await p.getByTestId('export-package').isEnabled(), text: (await p.getByTestId('export-package').innerText()).trim() } : null,
    exportCardHeading: await p.locator('.export-card h3').count() ? await p.locator('.export-card h3').innerText() : null,
    liveDownloadLinks: await q('a[href*="/exports"], a[href*="artifact"], [data-testid^="download-"] a, a[data-testid^="download-"]'),
    anchorsInExportCard: await q('.export-card a'),
    checksums: await q('[data-testid^="export-checksum-"]'),
    receiptHashes: await q('[data-testid^="export-receipt-hash"]'),
    downloadsCard: await q('[data-testid="downloads"]'),
    downloadsRefused: await q('[data-testid="downloads-refused"]'),
    receiptRefused: await q('[data-testid="export-receipt-refused"]'),
    exportReason: await q('[data-testid="export-disabled-reason"]') ? await p.getByTestId('export-disabled-reason').innerText() : null,
    packageReason: await q('[data-testid="export-package-disabled-reason"]') ? await p.getByTestId('export-package-disabled-reason').innerText() : null,
    approvedReleasePackageText: await p.getByText('Approved release package').count(),
    approvedArtifactExportText: await p.getByText('Approved artifact export').count(),
  };
  await p.screenshot({ path: out + '-full.png', fullPage: true });
  for (const [id, name] of [['export-panel', 'export-panel'], ['downloads-refused', 'downloads'], ['downloads', 'downloads']]) {
    const l = p.getByTestId(id); if (await l.count()) { await l.first().scrollIntoViewIfNeeded(); await l.first().screenshot({ path: `${out}-${name}.png` }); }
  }
  if (await q('.export-card')) { await p.locator('.export-card').scrollIntoViewIfNeeded(); await p.locator('.export-card').screenshot({ path: out + '-report-assembly-export-card.png' }); }
  // Viewport shot with the reason scrolled into view: is the ChatDock covering it?
  for (const id of ['export-disabled-reason', 'export-package-disabled-reason']) {
    const l = p.getByTestId(id);
    if (await l.count()) {
      await l.scrollIntoViewIfNeeded();
      const r = await l.boundingBox(); const d = await p.getByTestId('chat-dock').boundingBox();
      facts[`${id}_box`] = r; facts.chatDockBox = d;
      facts[`${id}_coveredByDock`] = !!(r && d && r.y + r.height > d.y);
      await p.screenshot({ path: `${out}-viewport-${id}.png` });
    }
  }
  facts.exportRequestsDuringView = reqs;
  console.log(JSON.stringify(facts, null, 2));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
