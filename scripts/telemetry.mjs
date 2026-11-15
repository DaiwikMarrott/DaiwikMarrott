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
    days,
    ...trainingLog(days),
    recent: user.repositories.nodes.filter((r) => r.name !== LOGIN).slice(0, 5),
  };
}

function trainingLog(days) {
  let longestStreak = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  const active = days.filter((d) => d.contributionCount > 0);
  const bestDay = days.reduce((best, d) => (d.contributionCount > best.contributionCount ? d : best), days[0]);
  const volume = active.reduce((sum, d) => sum + d.contributionCount, 0);
  return { longestStreak, bestDay, avgPerSession: active.length ? volume / active.length : 0 };
}

const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

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

// Isometric contribution calendar for the last 26 weeks, drawn back to front.
const ISO_LEVELS = [
  ['#2a2a36', '#1f1f29', '#18181f'],
  ['#5c1210', '#45100e', '#360c0b'],
  ['#9b1410', '#7a100d', '#5e0c0a'],
  ['#d8140c', '#ad100a', '#860c08'],
  ['#ff3b30', '#d6261c', '#a81b13'],
];

function renderCalendar(s) {
  const weeks = [];
  for (let i = 0; i < s.days.length; i += 7) weeks.push(s.days.slice(i, i + 7));
  const recent = weeks.slice(-26);
  const max = Math.max(1, ...recent.flat().map((d) => d.contributionCount));
  const [hw, hh, ox, oy, tall] = [14, 8, 150, 140, 72];

  const columns = recent.map((week, w) => {
    const bars = week.map((day, d) => {
      const n = day.contributionCount;
      const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
      const [top, left, right] = ISO_LEVELS[level];
      const h = 3 + (n / max) * tall;
      const x = ox + (w - d) * hw;
      const y = oy + (w + d) * hh;
      const p = (pts) => pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      return `<polygon points="${p([[x - hw, y - h], [x, y - h + hh], [x, y + hh], [x - hw, y]])}" fill="${left}"/>`
        + `<polygon points="${p([[x, y - h + hh], [x + hw, y - h], [x + hw, y], [x, y + hh]])}" fill="${right}"/>`
        + `<polygon points="${p([[x, y - h - hh], [x + hw, y - h], [x, y - h + hh], [x - hw, y - h]])}" fill="${top}"/>`;
    });
    // Within a week, later days sit closer to the viewer, so draw them last.
    return `<g class="wk" style="animation-delay:${(w * 0.035).toFixed(3)}s">${bars.join('')}</g>`;
  });

  const period = recent.flat();
  const total = period.reduce((sum, d) => sum + d.contributionCount, 0);
  const best = period.reduce((b, d) => (d.contributionCount > b.contributionCount ? d : b), period[0]);
  const tiles = [
    ['RACES ENTERED · 26 WKS', fmt(total), '#ff2a1f'],
    ['POLE POSITION · BEST DAY', `${fmt(best.contributionCount)} · ${shortDate(best.date)}`, '#a855f7'],
    ['DAYS ON TRACK · 26 WKS', fmt(period.filter((d) => d.contributionCount > 0).length), '#ffd12e'],
  ].map(([label, value, color], i) => `<g class="tile" style="animation-delay:${0.9 + i * 0.12}s">
      <rect x="640" y="${110 + i * 74}" width="4" height="52" fill="${color}"/>
      <text class="mono" x="660" y="${128 + i * 74}" font-size="12" fill="#9a9aab" letter-spacing="1.5">${label}</text>
      <text class="sans" x="660" y="${158 + i * 74}" font-size="28" font-weight="900" font-style="italic" fill="#ffffff">${esc(value)}</text>
    </g>`).join('\n');
  const legend = ISO_LEVELS.map(([top], i) => `<rect x="${960 + i * 22}" y="352" width="16" height="16" rx="3" fill="${top}"/>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t">
  <title id="t">3D contribution calendar for ${esc(LOGIN)}: ${fmt(total)} contributions over the last 26 weeks.</title>
  <defs>
    <clipPath id="frame"><rect width="1200" height="400" rx="16"/></clipPath>
    <style>
      .mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      .sans{font-family:'Titillium Web','Formula1 Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
      .wk,.tile{animation:drop .5s cubic-bezier(.2,.8,.2,1) both}
      @keyframes drop{from{opacity:0;transform:translateY(-18px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important}}
    </style>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="1200" height="400" fill="#15151e"/>
    <text class="sans" x="32" y="46" font-size="22" font-weight="900" font-style="italic" fill="#ffffff">SEASON CALENDAR</text>
    <text class="mono" x="34" y="70" font-size="12" fill="#9a9aab" letter-spacing="2">CONTRIBUTIONS · LAST 26 WEEKS · EACH TOWER = ONE DAY</text>
    ${columns.join('\n    ')}
    ${tiles}
    <text class="mono" x="950" y="364" font-size="11" fill="#9a9aab" text-anchor="end">LIGHTS OFF</text>
    ${legend}
    <text class="mono" x="1072" y="364" font-size="11" fill="#9a9aab">FULL THROTTLE</text>
  </g>
</svg>
`;
}

// Barbell that loads its plates and hits one double, beside coding "personal records".
function renderWeightRoom(s) {
  const plates = [[18, 150, '#e10600'], [16, 150, '#2f80ff'], [14, 122, '#ffd12e'], [12, 100, '#39d353']];
  let offset = 0;
  const side = (dir) => plates.map(([w, h, color], i) => {
    const x = dir < 0 ? 196 - offset - w : 404 + offset;
    offset += w + 3;
    return `<rect class="plate ${dir < 0 ? 'pl' : 'pr'}" style="animation-delay:${(0.2 + i * 0.18).toFixed(2)}s" x="${x}" y="${150 - h / 2}" width="${w}" height="${h}" rx="3" fill="${color}"/>`;
  }).join('');
  const left = side(-1);
  offset = 0;
  const right = side(1);

  const rows = [
    ['HEAVIEST SESSION · BEST DAY', `${fmt(s.bestDay.contributionCount)} reps · ${shortDate(s.bestDay.date)}`],
    ['LONGEST STREAK · NO REST DAYS', `${fmt(s.longestStreak)} days`],
    ['TRAINING DAYS · 12M', fmt(s.activeDays)],
    ['AVG REPS PER SESSION', s.avgPerSession.toFixed(1)],
  ].map(([label, value], i) => `<g class="row" style="animation-delay:${1 + i * 0.1}s">
      <text class="mono" x="650" y="${108 + i * 44}" font-size="12" fill="#9a9aab" letter-spacing="1.5">${label}</text>
      <text class="mono" x="1168" y="${108 + i * 44}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="end">${esc(value)}</text>
      <line x1="650" x2="1168" y1="${122 + i * 44}" y2="${122 + i * 44}" stroke="#262633"/>
    </g>`).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300" viewBox="0 0 1200 300" role="img" aria-labelledby="t">
  <title id="t">The weight room: a barbell loads up and lifts. Coding personal records: best day ${fmt(s.bestDay.contributionCount)} contributions, longest streak ${fmt(s.longestStreak)} days.</title>
  <defs>
    <clipPath id="frame"><rect width="1200" height="300" rx="16"/></clipPath>
    <style>
      .mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      .sans{font-family:'Titillium Web','Formula1 Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
      .plate{animation:.45s cubic-bezier(.2,.8,.2,1) both}
      .pl{animation-name:inl}.pr{animation-name:inr}
      @keyframes inl{from{opacity:0;transform:translateX(-140px)}to{opacity:1;transform:none}}
      @keyframes inr{from{opacity:0;transform:translateX(140px)}to{opacity:1;transform:none}}
      .lift{animation:lift 1.4s ease-in-out 1.2s 2 both}
      @keyframes lift{0%,100%{transform:none}45%,60%{transform:translateY(-38px)}}
      .shadow{transform-box:fill-box;transform-origin:center;animation:shrink 1.4s ease-in-out 1.2s 2 both}
      @keyframes shrink{0%,100%{transform:none;opacity:.5}45%,60%{transform:scaleX(.75);opacity:.25}}
      .row{animation:in .5s ease-out both}
      @keyframes in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important}}
    </style>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="1200" height="300" fill="#15151e"/>
    <rect width="600" height="300" fill="#101017"/>
    <text class="sans" x="32" y="46" font-size="22" font-weight="900" font-style="italic" fill="#ffffff">THE WEIGHT ROOM</text>
    <text class="mono" x="34" y="70" font-size="12" fill="#9a9aab" letter-spacing="2">OFF TRACK · TRAINING DAY</text>
    <rect x="40" y="262" width="520" height="6" rx="3" fill="#262633"/>
    <ellipse class="shadow" cx="300" cy="258" rx="230" ry="6" fill="#000"/>
    <g transform="translate(0 30)">
      <g class="lift">
        <rect x="70" y="146" width="460" height="8" rx="4" fill="#b9b9c6"/>
        <rect x="70" y="141" width="70" height="18" rx="4" fill="#d8d8e0"/>
        <rect x="460" y="141" width="70" height="18" rx="4" fill="#d8d8e0"/>
        <rect x="196" y="138" width="8" height="24" rx="2" fill="#6b6b7b"/>
        <rect x="396" y="138" width="8" height="24" rx="2" fill="#6b6b7b"/>
        ${left}${right}
      </g>
    </g>
    <text class="sans" x="650" y="46" font-size="22" font-weight="900" font-style="italic" fill="#ffffff">PERSONAL RECORDS</text>
    <text class="mono" x="652" y="70" font-size="12" fill="#e10600" letter-spacing="2">THE OTHER KIND OF PR · ONE REP = ONE CONTRIBUTION</text>
    ${rows}
    <text class="mono" x="650" y="282" font-size="12" fill="#6b6b7b">// progressive overload, applied to code</text>
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
await writeFile(new URL('../assets/calendar.svg', import.meta.url), renderCalendar(stats));
await writeFile(new URL('../assets/weight-room.svg', import.meta.url), renderWeightRoom(stats));

const readmeUrl = new URL('../README.md', import.meta.url);
const readme = await readFile(readmeUrl, 'utf8');
await writeFile(readmeUrl, readme.replace(
  /(<!-- PITSTOPS:START -->)[\s\S]*?(<!-- PITSTOPS:END -->)/,
  `$1\n${renderPitStops(stats.recent)}\n$2`,
));
console.log(`telemetry: ${stats.contributions} contributions, ${stats.langs.length} languages, ${stats.recent.length} pit stops`);
