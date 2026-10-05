import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const LOGIN = "SebastianLopezO";
const WAKATIME_USER = "SebastianLopezO";
const output = process.argv[2] ?? "metrics/stats.json";

const YEAR_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner isPrivate owner { login __typename } primaryLanguage { name } }
        contributions { totalCount }
      }
    }
  }
}`;

const PROFILE_QUERY = `query($login: String!) {
  viewer { login }
  user(login: $login) {
    createdAt
    organizations(first: 100) { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false) { totalCount }
  }
}`;

async function graphql(token, query, variables) {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": LOGIN},
        body: JSON.stringify({query, variables}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors) {
        const error = new Error(`GitHub GraphQL ${response.status}: ${JSON.stringify(body.errors ?? body.message ?? body)}`);
        error.status = response.status;
        throw error;
    }
    return body.data;
}

// The owner's token sees private contributions; the workflow token only sees what the public profile shows.
async function connect() {
    const candidates = [["owner", process.env.GH_TOKEN], ["public", process.env.GITHUB_TOKEN]].filter(([, token]) => token);
    for (const [visibility, token] of candidates) {
        try {
            const profile = await graphql(token, PROFILE_QUERY, {login: LOGIN});
            const owner = profile.viewer?.login === LOGIN;
            if (visibility === "owner" && !owner) console.warn(`GH_TOKEN belongs to ${profile.viewer?.login}, not ${LOGIN}`);
            return {token, profile: profile.user, visibility: owner ? "owner" : "public"};
        } catch (error) {
            console.warn(`${visibility} token rejected: ${error.message}`);
        }
    }
    throw new Error("No GitHub token worked. Renew the METRICS_TOKEN secret (classic token with repo, read:org and read:user).");
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const addDays = (day, count) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000));

export function computeStreaks(days, today) {
    const active = new Set(days.filter((day) => day.count > 0).map((day) => day.date));
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    let longest = {days: 0, from: null, to: null};
    let run = null;
    for (const {date, count} of sorted) {
        if (count > 0) {
            run = run && addDays(run.to, 1) === date ? {...run, to: date, days: run.days + 1} : {days: 1, from: date, to: date};
            if (run.days > longest.days) longest = run;
        } else {
            run = null;
        }
    }
    let end = active.has(today) ? today : addDays(today, -1);
    let current = {days: 0, from: null, to: null};
    if (active.has(end)) {
        let start = end;
        while (active.has(addDays(start, -1))) start = addDays(start, -1);
        current = {days: Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1, from: start, to: end};
    }
    return {longest, current};
}

export function summarizeDays(days) {
    const weekdays = Array(7).fill(0);
    let best = {date: null, contributions: 0};
    for (const {date, count} of days) {
        weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()] += count;
        if (count > best.contributions) best = {date, contributions: count};
    }
    return {weekdays, bestDay: best, activeDays: days.filter((day) => day.count > 0).length, days: days.length};
}

async function collectGitHub({token, profile, visibility}, now) {
    const since = profile.createdAt.slice(0, 10);
    const firstYear = Number(since.slice(0, 4));
    const today = isoDay(now);
    const years = [];
    const days = new Map();
    const languages = new Map();
    // Repository and organization names stay in memory: only counts are written, so no client name is published.
    const repositories = new Set();
    const privateRepositories = new Set();
    const organizations = new Set();

    for (let year = firstYear; year <= now.getUTCFullYear(); year += 1) {
        const from = year === firstYear ? `${since}T00:00:00Z` : `${year}-01-01T00:00:00Z`;
        const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
        const {user} = await graphql(token, YEAR_QUERY, {login: LOGIN, from, to});
        const collection = user.contributionsCollection;
        const yearDays = collection.contributionCalendar.weeks
            .flatMap((week) => week.contributionDays)
            .filter((day) => day.date >= from.slice(0, 10) && day.date <= to.slice(0, 10) && day.date <= today)
            .map((day) => ({date: day.date, count: day.contributionCount}));
        for (const day of yearDays) days.set(day.date, day);
        for (const {repository, contributions} of collection.commitContributionsByRepository) {
            repositories.add(repository.nameWithOwner);
            if (repository.isPrivate) privateRepositories.add(repository.nameWithOwner);
            if (repository.owner.__typename === "Organization") organizations.add(repository.owner.login);
            const language = repository.primaryLanguage?.name;
            if (language) languages.set(language, (languages.get(language) ?? 0) + contributions.totalCount);
        }
        years.push({
            year,
            contributions: collection.contributionCalendar.totalContributions,
            commits: collection.totalCommitContributions,
            pullRequests: collection.totalPullRequestContributions,
            reviews: collection.totalPullRequestReviewContributions,
            issues: collection.totalIssueContributions,
            repositoriesCreated: collection.totalRepositoryContributions,
            restricted: collection.restrictedContributionsCount,
            ...summarizeDays(yearDays),
        });
    }

    const allDays = [...days.values()];
    const sum = (key) => years.reduce((total, year) => total + year[key], 0);
    const languageTotal = [...languages.values()].reduce((a, b) => a + b, 0);
    const {weekdays, bestDay, activeDays} = summarizeDays(allDays);

    return {
        visibility,
        since,
        totals: {
            contributions: sum("contributions"),
            commits: sum("commits"),
            pullRequests: sum("pullRequests"),
            reviews: sum("reviews"),
            issues: sum("issues"),
            repositoriesCreated: sum("repositoriesCreated"),
            activeDays,
            days: allDays.length,
        },
        years: years.map(({weekdays: _weekdays, bestDay: _bestDay, ...year}) => year),
        streaks: computeStreaks(allDays, today),
        bestDay,
        weekdays,
        repositories: {owned: profile.repositories.totalCount, contributedTo: repositories.size, private: privateRepositories.size},
        organizations: {member: profile.organizations.totalCount, contributedTo: organizations.size},
        languagesByCommits: [...languages]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, commits]) => ({name, commits, share: Number(((commits / languageTotal) * 100).toFixed(1))})),
    };
}

async function wakatimeRequest(path) {
    const key = process.env.WAKATIME_API_KEY;
    const user = key ? "current" : WAKATIME_USER;
    const headers = key ? {Authorization: `Basic ${Buffer.from(key).toString("base64")}`} : {};
    const response = await fetch(`https://wakatime.com/api/v1/users/${user}/${path}`, {headers});
    if (response.status !== 200) return null;
    return (await response.json()).data ?? null;
}

const pick = (items = [], limit = 10) =>
    items.slice(0, limit).map(({name, percent, total_seconds: seconds, text}) => ({name, percent, seconds: Math.round(seconds), text}));

// Free WakaTime plans may not expose every range, so the widest one available is used and recorded.
async function collectWakaTime() {
    const allTime = await wakatimeRequest("all_time_since_today").catch(() => null);
    for (const range of ["all_time", "last_year", "last_6_months", "last_30_days", "last_7_days"]) {
        const stats = await wakatimeRequest(`stats/${range}`).catch(() => null);
        if (!stats?.languages?.length) continue;
        return {
            range,
            start: stats.start?.slice(0, 10) ?? null,
            end: stats.end?.slice(0, 10) ?? null,
            totalSeconds: Math.round(stats.total_seconds ?? 0),
            totalText: stats.human_readable_total ?? null,
            dailyAverageText: stats.human_readable_daily_average ?? null,
            bestDay: stats.best_day ? {date: stats.best_day.date, text: stats.best_day.text} : null,
            languages: pick(stats.languages),
            editors: pick(stats.editors, 5),
            operatingSystems: pick(stats.operating_systems, 3),
            categories: pick(stats.categories, 5),
            allTime: allTime ? {seconds: Math.round(allTime.total_seconds ?? 0), text: allTime.text ?? null, since: allTime.range?.start?.slice(0, 10) ?? null} : null,
        };
    }
    console.warn("WakaTime stats unavailable: make the profile stats public or add the WAKATIME_API_KEY secret.");
    return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const now = new Date();
    const connection = await connect();
    const stats = {
        generatedAt: now.toISOString(),
        login: LOGIN,
        github: await collectGitHub(connection, now),
        wakatime: await collectWakaTime(),
    };
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, `${JSON.stringify(stats, null, 2)}\n`);
    const {github, wakatime} = stats;
    console.log(`GitHub (${github.visibility}) since ${github.since}: ${github.totals.contributions} contributions, ${github.totals.commits} commits`);
    console.log(`Longest streak ${github.streaks.longest.days} days (${github.streaks.longest.from} to ${github.streaks.longest.to}), current ${github.streaks.current.days}`);
    for (const year of github.years) console.log(`  ${year.year}: ${year.contributions} contributions, ${year.commits} commits, ${year.activeDays}/${year.days} active days`);
    console.log(wakatime ? `WakaTime ${wakatime.range}: ${wakatime.totalText}, top ${wakatime.languages.slice(0, 3).map((l) => l.name).join(", ")}` : "WakaTime: none");
}
