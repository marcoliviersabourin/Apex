// APEX 13F Fetcher — runs inside GitHub Actions (server-side, no CORS)
// Fetches complete 13F holdings for tracked funds from SEC EDGAR,
// parses every position, writes data/13f-holdings.json for APEX to read.
//
// SEC requires a User-Agent header with a real contact email.
const USER_AGENT = 'APEX Portfolio App marc.olivier.sabourin@gmail.com';

// Verified CIKs. Klarman/Baupost corrected. Hindenburg removed (defunct, no 13F — CIK 1864163
// was wrong entity "Inter & Co"). Short-sellers rarely file 13F (they hold puts, not $100M+ longs).
const FUNDS = {
  '1649339': 'Michael Burry / Scion Asset Management',
  '1067983': 'Warren Buffett / Berkshire Hathaway',
  '1656456': 'David Tepper / Appaloosa Management',
  '1336528': 'Bill Ackman / Pershing Square Capital',
  '1166559': 'Bill Gates / Gates Foundation Trust',
  '1350694': 'Ray Dalio / Bridgewater Associates',
  '1423053': 'Ken Griffin / Citadel Advisors',
  '1536411': 'Stanley Druckenmiller / Duquesne Family Office',
  '1029160': 'George Soros / Soros Fund Management',
  '921669':  'Carl Icahn / Icahn Capital',
  '1061768': 'Seth Klarman / Baupost Group',
  '1079114': 'David Einhorn / Greenlight Capital',
  '1040273': 'Daniel Loeb / Third Point',
};

// Keep only meaningful positions. Mega-funds (Citadel, Bridgewater) file thousands of
// tiny market-making/hedging stakes that are pure noise. Keep positions worth >= this ($K).
// $5,000K = $5M minimum. Also always keep ALL puts/calls regardless of size (they're signals).
const MIN_POSITION_VALUE_K = 5000;
const MAX_POSITIONS_PER_FUND = 100; // top N by value after filtering

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function secFetch(url, asJson = true) {
  // SEC fair-access: max 10 req/sec. We stay well under with delays.
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return asJson ? resp.json() : resp.text();
}

// Find the most recent 13F-HR filing for a CIK
async function findLatest13F(cik) {
  const padded = cik.padStart(10, '0');
  const sub = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  const recent = sub.filings?.recent;
  if (!recent?.form) return { entityName: sub.name || '?', filing: null };

  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === '13F-HR' || recent.form[i] === '13F-HR/A') {
      return {
        entityName: sub.name || '?',
        filing: {
          accession: recent.accessionNumber[i].replace(/-/g, ''),
          filingDate: recent.filingDate[i],
          reportDate: recent.reportDate?.[i] || recent.filingDate[i],
          form: recent.form[i],
        }
      };
    }
  }
  return { entityName: sub.name || '?', filing: null };
}

// Locate the information-table XML inside a filing and parse positions
async function fetchPositions(cik, accession) {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}`;
  // The filing index lists all documents
  const index = await secFetch(`${base}/index.json`);
  const items = index.directory?.item || [];

  // Find the info-table XML: it's an .xml file that is NOT the primary_doc
  let infoTableName = null;
  for (const it of items) {
    const n = (it.name || '').toLowerCase();
    if (n.endsWith('.xml') && !n.includes('primary_doc') && !n.includes('primarydoc')) {
      infoTableName = it.name;
      // Prefer files that look like info tables
      if (n.includes('infotable') || n.includes('form13f') || n.includes('information')) break;
    }
  }
  if (!infoTableName) return [];

  const xml = await secFetch(`${base}/${infoTableName}`, false);
  return parseInfoTable(xml);
}

// Parse the 13F information table XML into structured positions
function parseInfoTable(xml) {
  const positions = [];
  // infoTable blocks — namespace-agnostic regex (XML parsers vary; regex is robust here)
  const blocks = xml.match(/<(?:\w+:)?infoTable\b[\s\S]*?<\/(?:\w+:)?infoTable>/g) || [];
  for (const b of blocks) {
    const grab = (tag) => {
      const m = b.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const issuer = grab('nameOfIssuer');
    const value = parseInt(grab('value').replace(/[^0-9]/g, '')) || 0; // in $ thousands
    const shares = parseInt(grab('sshPrnamt').replace(/[^0-9]/g, '')) || 0;
    const putCall = grab('putCall').toUpperCase();
    const titleClass = grab('titleOfClass');
    const cusip = grab('cusip');
    if (issuer) {
      positions.push({ issuer, cusip, value, shares, putCall, titleOfClass: titleClass });
    }
  }
  return positions;
}

async function main() {
  const output = { generated: new Date().toISOString(), source: 'SEC EDGAR', funds: {} };
  const problems = [];

  for (const [cik, label] of Object.entries(FUNDS)) {
    try {
      console.log(`Fetching ${label} (CIK ${cik})...`);
      const { entityName, filing } = await findLatest13F(cik);
      await sleep(250);

      if (!filing) {
        problems.push(`${label} (CIK ${cik}): entity "${entityName}" — NO 13F-HR filing found`);
        output.funds[cik] = { label, cik, entityName, error: 'No 13F filing', positions: [] };
        continue;
      }

      const rawPositions = await fetchPositions(cik, filing.accession);
      await sleep(250);

      // Dedupe by CUSIP+putCall (voting-authority rows can split one holding into 3)
      const byKey = {};
      for (const p of rawPositions) {
        const k = (p.cusip || p.issuer) + '|' + (p.putCall || '');
        if (byKey[k]) {
          byKey[k].shares += p.shares;
          byKey[k].value += p.value;
        } else {
          byKey[k] = { ...p };
        }
      }
      let deduped = Object.values(byKey);
      const rawCount = rawPositions.length;
      const dedupCount = deduped.length;

      // Keep ALL puts/calls (signals), filter longs by min value, then cap at top N
      const options = deduped.filter(p => p.putCall === 'PUT' || p.putCall === 'CALL');
      let longs = deduped.filter(p => !p.putCall);
      longs.sort((a, b) => b.value - a.value);
      const bigLongs = longs.filter(p => p.value >= MIN_POSITION_VALUE_K).slice(0, MAX_POSITIONS_PER_FUND);
      const positions = [...options, ...bigLongs];

      const puts = options.filter(p => p.putCall === 'PUT').length;
      const calls = options.filter(p => p.putCall === 'CALL').length;
      console.log(`  → ${entityName}: raw ${rawCount} → dedup ${dedupCount} → kept ${positions.length} (${puts}p/${calls}c/${bigLongs.length} longs≥$5M), report ${filing.reportDate}`);

      if (positions.length === 0) {
        problems.push(`${label} (CIK ${cik}): filing found but 0 positions after filtering (raw was ${rawCount})`);
      }

      output.funds[cik] = {
        label, cik, entityName,
        filingDate: filing.filingDate,
        reportDate: filing.reportDate,
        form: filing.form,
        rawPositionCount: rawCount,
        positionCount: positions.length,
        positions,
      };
    } catch (e) {
      problems.push(`${label} (CIK ${cik}): ERROR ${e.message}`);
      output.funds[cik] = { label, cik, error: e.message, positions: [] };
    }
    await sleep(300); // stay well under SEC's 10 req/sec
  }

  output.problems = problems;
  output.fundCount = Object.keys(output.funds).length;
  output.totalPositions = Object.values(output.funds).reduce((s, f) => s + (f.positions?.length || 0), 0);

  const fs = require('fs');
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/13f-holdings.json', JSON.stringify(output, null, 2));

  // Also write a TINY human-readable summary that GitHub can always render
  // (the main JSON may be too big for GitHub's web viewer).
  let summary = `APEX 13F FETCH SUMMARY\n`;
  summary += `Generated: ${output.generated}\n`;
  summary += `Funds: ${output.fundCount} | Total kept positions: ${output.totalPositions}\n`;
  summary += `File size: ${(JSON.stringify(output).length / 1024).toFixed(0)} KB\n`;
  summary += `${'='.repeat(50)}\n\n`;
  Object.values(output.funds).forEach(f => {
    if (f.error) { summary += `${f.label}: ERROR — ${f.error}\n`; return; }
    const puts = (f.positions || []).filter(p => p.putCall === 'PUT').length;
    const calls = (f.positions || []).filter(p => p.putCall === 'CALL').length;
    summary += `${f.label}\n`;
    summary += `  CIK ${f.cik} | ${f.entityName}\n`;
    summary += `  Report: ${f.reportDate} | raw ${f.rawPositionCount || '?'} → kept ${f.positionCount} (${puts} puts, ${calls} calls)\n\n`;
  });
  if (problems.length) {
    summary += `PROBLEMS:\n`;
    problems.forEach(p => summary += `  - ${p}\n`);
  }
  fs.writeFileSync('data/13f-summary.txt', summary);

  console.log('\n=== SUMMARY ===');
  console.log(`Funds: ${output.fundCount} | Total positions: ${output.totalPositions} | Size: ${(JSON.stringify(output).length/1024).toFixed(0)}KB`);
  console.log(summary);
  if (problems.length) {
    console.log('⚠ PROBLEMS (fix these CIKs):');
    problems.forEach(p => console.log('  ' + p));
  } else {
    console.log('✓ All funds fetched cleanly');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
