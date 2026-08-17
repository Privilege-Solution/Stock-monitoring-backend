// =============================================================================
// Publisher display-name ↔ hostname map.
//
// WHY THIS EXISTS: news_feed.source_label is what the publisher calls itself,
// and for Thai outlets that is a Thai string that shares NOTHING with the
// hostname. Measured on the live table:
//
//     source_label          hostname
//     กรุงเทพธุรกิจ            bangkokbiznews.com
//     สยามรัฐ                 siamrath.co.th
//     แนวหน้า                 naewna.com
//     ฐานเศรษฐกิจ             thansettakij.com
//
// A naive `label.includes(host)` check would therefore report a mismatch on
// essentially every Thai row — the check would be worse than no check, because
// it would train the operator to ignore it. Matching needs this table.
//
// SYNDICATION: labels like "กรุงเทพธุรกิจ on MSN" are Bing surfacing a Thai
// outlet's article republished on MSN. hostname is msn.com while the label
// names the original publisher. That is CORRECT, not a mismatch — see
// SYNDICATION_HOSTS below.
// =============================================================================

// hostname (no leading www.) → every display name that legitimately labels it.
// Latin aliases are matched case-insensitively; Thai aliases are matched as-is.
export const HOST_ALIASES = {
  'bangkokbiznews.com':  ['กรุงเทพธุรกิจ', 'Krungthep Turakij', 'Bangkok Biz News', 'bangkokbiznews'],
  'siamrath.co.th':      ['สยามรัฐ', 'Siam Rath', 'siamrath'],
  'naewna.com':          ['แนวหน้า', 'Naewna'],
  'thansettakij.com':    ['ฐานเศรษฐกิจ', 'Thansettakij'],
  'dailynews.co.th':     ['เดลินิวส์', 'Daily News', 'Dailynews'],
  'thaipost.net':        ['ไทยโพสต์', 'Thai Post', 'Thaipost'],
  'prachachat.net':      ['ประชาชาติธุรกิจ', 'Prachachat', 'Prachachat Turakij'],
  'matichon.co.th':      ['มติชน', 'Matichon'],
  'khaosod.co.th':       ['ข่าวสด', 'Khaosod'],
  'thairath.co.th':      ['ไทยรัฐ', 'Thairath'],
  'posttoday.com':       ['โพสต์ทูเดย์', 'Post Today'],
  'kaohoon.com':         ['ข่าวหุ้น', 'ข่าวหุ้นธุรกิจ', 'Kaohoon'],
  'hooninside.com':      ['หุ้นอินไซด์', 'Hooninside', 'HoonInside'],
  'hoonsmart.com':       ['หุ้นสมาร์ท', 'HoonSmart', 'Hoonsmart'],
  'ryt9.com':            ['RYT9', 'ryt9', 'อาร์วายที9'],
  'set.or.th':           ['SET', 'ตลาดหลักทรัพย์', 'ตลาดหลักทรัพย์แห่งประเทศไทย', 'SETTRADE'],
  'settrade.com':        ['Settrade', 'สยามทรัพย์'],
  'reic.or.th':          ['REIC', 'ศูนย์ข้อมูลอสังหาริมทรัพย์'],
  'bot.or.th':           ['ธปท.', 'ธปท', 'ธนาคารแห่งประเทศไทย', 'BOT', 'Bank of Thailand'],
  'thinkofliving.com':   ['ThinkOfLiving', 'thinkofliving', 'ธิงค์ออฟลิฟวิ่ง'],
  'ddproperty.com':      ['DDproperty', 'ddproperty'],
  'terrabkk.com':        ['TerraBKK', 'terrabkk'],
  'bangkokpost.com':     ['Bangkok Post', 'บางกอกโพสต์'],
  'nationthailand.com':  ['The Nation', 'Nation Thailand'],
  'nationtv.tv':         ['NationTV', 'เนชั่นทีวี', 'Nation TV'],
  'thebangkokinsight.com': ['The Bangkok Insight', 'Bangkok Insight'],
  'wealthythai.com':     ['Wealthy Thai', 'WealthyThai'],
  'moneyandbanking.co.th': ['การเงินธนาคาร', 'Money and Banking'],
  'thestandard.co':      ['THE STANDARD', 'The Standard'],
  'thecoverage.info':    ['The Coverage'],
  'infoquest.co.th':     ['InfoQuest', 'อินโฟเควสท์'],
  'mgronline.com':       ['ผู้จัดการ', 'MGR Online', 'Manager Online'],
  'thaipr.net':          ['ThaiPR', 'thaipr'],
  'assetwise.co.th':     ['AssetWise', 'แอสเซทไวส์', 'ASW'],
  'prd.go.th':           ['กรมประชาสัมพันธ์', 'PRD'],
  'aec10news.com':       ['AEC10News'],
  'thephuketnews.com':   ['The Phuket News'],
  'investing.com':       ['Investing.com', 'Investing'],
};

// Hosts that legitimately republish another outlet's article. On these, the
// label naming the ORIGINAL publisher is correct and must not be flagged.
// news.google.com / bing.com are NOT here — those are redirectors, rejected
// outright by the validator, never stored.
export const SYNDICATION_HOSTS = new Set([
  'msn.com',
  'news.line.me',
  'line.me',
  'flipboard.com',
  'finance.yahoo.com',
  // Press-release wires. These exist to carry OTHER organizations' releases
  // verbatim, so a label naming the issuing body (ธปท., NESDC, a listed company)
  // on one of these hosts is correct by design, not a mispairing. Without this
  // the checker flags every central-bank and government release it ingests.
  'thaipr.net',
  'ryt9.com',
  'newswit.com',
  'prnewswire.com',
  'businesswire.com',
]);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^www\./, '');

// Squash a display name to its comparable core: lowercase, "&" spelled out,
// and every separator removed. Without this, "Money & Banking Magazine" fails
// to match moneyandbanking.co.th — the ampersand and the spaces are the only
// difference, and reporting that as a wrong publisher is a false accusation.
// Thai characters are preserved; only ASCII punctuation and spacing go.
const squash = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9฀-๿]+/g, '');

// Strip a syndication suffix so "กรุงเทพธุรกิจ on MSN" still matches
// bangkokbiznews.com when we want to know who actually wrote it.
export function stripSyndicationSuffix(label) {
  return String(label || '').replace(/\s+on\s+(MSN|LINE|Flipboard|Yahoo)\s*$/i, '').trim();
}

// Does `host` belong to the publisher named by `label`?
//
// Returns one of:
//   'match'        — the label names this host (via alias table or substring)
//   'syndicated'   — host is a syndication platform and the label names the
//                    original publisher; correct, not a mismatch
//   'unknown'      — we have no alias entry for this host, so we CANNOT say.
//                    Deliberately distinct from 'mismatch': an unlisted
//                    publisher must not be reported as wrong just because the
//                    table is incomplete.
//   'mismatch'     — the host IS in the table and the label names a DIFFERENT
//                    publisher. This is the only confident negative.
export function labelMatchesHost(label, host) {
  const h = norm(host);
  // Strip markdown emphasis the model sometimes leaks into the label ("** ธปท.").
  const rawLabel = String(label || '').replace(/^[*\s]+/, '').trim();
  if (!h) return 'unknown';
  if (!rawLabel) return 'unknown';

  // A label may credit SEVERAL outlets ("NESDC / Thai PBS / GWA Asia",
  // "กรุงเทพธุรกิจ, THE STANDARD WEALTH"). Matching any ONE of them is enough —
  // the story is genuinely attributed to that set, and demanding that the
  // hostname match the whole string reports every co-credited row as wrong.
  const credited = rawLabel.split(/\s*[/,;|]\s*|\s+และ\s+/).map(s => s.trim()).filter(Boolean);
  if (credited.length > 1) {
    const verdicts = credited.map(p => labelMatchesHost(p, host));
    if (verdicts.includes('match')) return 'match';
    if (verdicts.includes('syndicated')) return 'syndicated';
    if (verdicts.includes('unknown')) return 'unknown';   // can't be sure → don't accuse
    return 'mismatch';
  }

  const baseLabel = stripSyndicationSuffix(rawLabel);
  const lLower = baseLabel.toLowerCase();

  // Registrable-ish host key: try the full host, then walk up one label at a
  // time so "investor.assetwise.co.th" resolves to the "assetwise.co.th" entry.
  const candidates = [];
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) candidates.push(parts.slice(i).join('.'));

  const entryKey = candidates.find(c => HOST_ALIASES[c]);

  // The label already contains the hostname (or its first label) verbatim —
  // "thinkofliving.com" labelling thinkofliving.com, "RYT9" labelling ryt9.com,
  // "Money & Banking Magazine" labelling moneyandbanking.co.th.
  const hostWord = (entryKey || h).split('.')[0];
  const squashedLabel = squash(baseLabel);
  if (lLower.includes(hostWord) || squashedLabel.includes(squash(hostWord))) return 'match';

  if (entryKey) {
    const aliases = HOST_ALIASES[entryKey];
    if (aliases.some(a => /[฀-๿]/.test(a)
        ? baseLabel.includes(a)
        : squashedLabel.includes(squash(a)))) {
      return 'match';
    }
  }

  // Syndication: the platform host is fine as long as some publisher name is
  // present. Checked AFTER the alias pass so a genuine line.me story still
  // matches on its own name.
  if (candidates.some(c => SYNDICATION_HOSTS.has(c))) return 'syndicated';

  // Only call it a mismatch when the host is one we actually know. An unlisted
  // host means the table is incomplete, not that the row is wrong.
  return entryKey ? 'mismatch' : 'unknown';
}

// Which publisher does this hostname belong to, for display when the stored
// label disagrees? Returns the first (canonical) alias, or null when unlisted.
export function publisherForHost(host) {
  const h = norm(host);
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(i).join('.');
    if (HOST_ALIASES[key]) return HOST_ALIASES[key][0];
  }
  return null;
}
