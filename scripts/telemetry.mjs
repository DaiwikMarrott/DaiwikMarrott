// Builds assets/telemetry.svg and refreshes the "Latest pit stops" block in README.md
// from the GitHub GraphQL API. Runs daily via .github/workflows/telemetry.yml.
// Usage: GITHUB_TOKEN=... node scripts/telemetry.mjs [login]

import { readFile, writeFile } from 'node:fs/promises';

const LOGIN = process.argv[2] ?? process.env.GITHUB_REPOSITORY_OWNER ?? 'DaiwikMarrott';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date } }
      }
    }
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name url description pushedAt
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } }
      }
    }
  }
}`;

async function fetchUser() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data.user;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => n.toLocaleString('en-US');

function summarize(user) {
  const cc = user.contributionsCollection;
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const weekly = cc.contributionCalendar.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));

  const bytes = new Map();
  for (const repo of user.repositories.nodes)
    for (const { size, node } of repo.languages.edges) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
  const langs = sorted.slice(0, 5).map(([name, size]) => ({ name, pct: size / total }));
  const rest = sorted.slice(5).reduce((s, [, size]) => s + size, 0);
  if (rest) langs.push({ name: 'Other', pct: rest / total });

  return {
    contributions: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions,
    repos: user.repositories.totalCount,
    bestWeek: Math.max(0, ...weekly),
    activeDays: days.filter((d) => d.contributionCount > 0).length,
    langCount: bytes.size,
    weekly,
    langs,
    recent: user.repositories.nodes.filter((r) => r.name !== LOGIN).slice(0, 5),
  };
}

// Tyre compound colours, softest first.
const COMPOUNDS = [
  ['#ff2a1f', 'S'], ['#ffd12e', 'M'], ['#f2f2f2', 'H'], ['#39d353', 'I'], ['#2f80ff', 'W'], ['#6b6b7b', '–'],
];

function renderSvg(s) {
  const rows = [
    ['CONTRIBUTIONS · 12M', fmt(s.contributions), '#a855f7'],
    ['COMMITS', fmt(s.commits), '#00d26a'],
    ['FASTEST LAP · BEST WEEK', fmt(s.bestWeek), '#a855f7'],
    ['DAYS ON TRACK · 12M', fmt(s.activeDays), '#ffd12e'],
    ['PUBLIC REPOS', fmt(s.repos), '#f2f2f2'],
    ['LANGUAGES IN THE GARAGE', fmt(s.langCount), '#f2f2f2'],
  ];
  const rowSvg = rows.map(([label, value, color], i) => {
    const y = 92 + i * 36;
    return `<g class="row" style="animation-delay:${0.1 + i * 0.08}s">
      <rect x="32" y="${y - 22}" width="4" height="28" fill="${color}"/>
      <text class="mono" x="48" y="${y - 2}" font-size="12" fill="#9a9aab" letter-spacing="1">${label}</text>
      <text class="mono" x="388" y="${y - 2}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="end">${esc(value)}</text>
    </g>`;
  }).join('\n');

  // Speed trace: weekly contributions over the last year.
  const [x0, x1, yTop, yBot] = [470, 1168, 70, 190];
  const max = Math.max(1, ...s.weekly);
  const pts = s.weekly.map((v, i) => {
    const x = x0 + (i / Math.max(1, s.weekly.length - 1)) * (x1 - x0);
    const y = yBot - (v / max) * (yBot - yTop);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `M${x0},${yBot} L${pts.join(' L')} L${x1},${yBot} Z`;

  let cursor = x0;
  const stint = s.langs.map((l, i) => {
    const w = l.pct * (x1 - x0);
    const [color, code] = l.name === 'Other' ? COMPOUNDS.at(-1) : COMPOUNDS[i];
    const seg = `<g class="stint" style="animation-delay:${0.9 + i * 0.12}s">
      <rect x="${cursor.toFixed(1)}" y="232" width="${Math.max(w - 3, 1).toFixed(1)}" height="14" rx="3" fill="${color}"/>
      <text class="mono" x="${x0 + (i % 3) * 233}" y="${270 + Math.floor(i / 3) * 20}" font-size="12" fill="#d8d8e0"><tspan fill="${color}" font-weight="700">${code}</tspan> ${esc(l.name)} ${(l.pct * 100).toFixed(1)}%</text>
    </g>`;
    cursor += w;
    return seg;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="316" viewBox="0 0 1200 316" role="img" aria-labelledby="t">
  <title id="t">GitHub telemetry for ${esc(LOGIN)}: ${fmt(s.contributions)} contributions in the last year, top languages ${s.langs.map((l) => esc(l.name)).join(', ')}.</title>
  <defs>
    <clipPath id="frame"><rect width="1200" height="316" rx="16"/></clipPath>
    <linearGradient id="trace" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e10600" stop-opacity=".45"/>
      <stop offset="1" stop-color="#e10600" stop-opacity="0"/>
    </linearGradient>
    <style>
      .mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      .sans{font-family:'Titillium Web','Formula1 Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
      .row{animation:slide .5s cubic-bezier(.2,.8,.2,1) both}
      @keyframes slide{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
      .line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s ease-out .3s forwards}
      @keyframes draw{to{stroke-dashoffset:0}}
      .area{animation:fade 1s ease-out 1.2s both}
      @keyframes fade{from{opacity:0}}
      .stint{transform-box:fill-box;transform-origin:left;animation:grow .5s ease-out both}
      @keyframes grow{from{opacity:0;transform:scaleX(0)}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important}.line{stroke-dashoffset:0}}
    </style>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="1200" height="316" fill="#15151e"/>
    <rect width="420" height="316" fill="#101017"/>
    <text class="sans" x="32" y="42" font-size="22" font-weight="900" font-style="italic" fill="#ffffff">TELEMETRY</text>
    <text class="mono" x="388" y="42" font-size="11" fill="#e10600" text-anchor="end" letter-spacing="2">LIVE · DAILY</text>
    ${rowSvg}
    <text class="mono" x="470" y="42" font-size="12" fill="#9a9aab" letter-spacing="2">SPEED TRACE · WEEKLY CONTRIBUTIONS · LAST 52 WEEKS</text>
    ${[0, 1, 2, 3].map((i) => `<line x1="${x0}" x2="${x1}" y1="${yTop + i * 40}" y2="${yTop + i * 40}" stroke="#262633" stroke-dasharray="2 6"/>`).join('')}
    <path class="area" d="${area}" fill="url(#trace)"/>
    <polyline class="line" pathLength="1" points="${pts.join(' ')}" fill="none" stroke="#ff2a1f" stroke-width="2.5" stroke-linejoin="round"/>
    <text class="mono" x="470" y="222" font-size="12" fill="#9a9aab" letter-spacing="2">TYRE STRATEGY · TOP LANGUAGES BY CODE</text>
    ${stint}
  </g>
</svg>
`;
}

function renderPitStops(recent) {
  return recent.map((r) => {
    const date = new Date(r.pushedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const desc = r.description ? ` — ${r.description.trim()}` : '';
    return `- 🔧 [**${r.name}**](${r.url})${desc} <sub>· ${date}</sub>`;
  }).join('\n');
}

const stats = summarize(await fetchUser());
await writeFile(new URL('../assets/telemetry.svg', import.meta.url), renderSvg(stats));

const readmeUrl = new URL('../README.md', import.meta.url);
const readme = await readFile(readmeUrl, 'utf8');
await writeFile(readmeUrl, readme.replace(
  /(<!-- PITSTOPS:START -->)[\s\S]*?(<!-- PITSTOPS:END -->)/,
  `$1\n${renderPitStops(stats.recent)}\n$2`,
));
console.log(`telemetry: ${stats.contributions} contributions, ${stats.langs.length} languages, ${stats.recent.length} pit stops`);
