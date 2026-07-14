import express from "express";
import * as cheerio from "cheerio";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
} from "discord.js";

const UPDATE_LIST_URL =
  "https://aion2.plaync.com/ko-kr/board/update/list";
const BASE_URL = "https://aion2.plaync.com";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const intervalMinutes = Math.max(
  10,
  Number.parseInt(process.env.CHECK_INTERVAL_MINUTES ?? "10", 10) || 10,
);

if (!token || !channelId) {
  console.error("필수 환경변수가 없습니다: DISCORD_TOKEN, DISCORD_CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const app = express();
app.get("/", (_req, res) => {
  res.status(200).send("AION2 patch bot is running.");
});
app.listen(process.env.PORT || 3000, () => {
  console.log("Health server started.");
});

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,*/*;q=0.8",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return null;

  const cleaned = value
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&")
    .trim();

  try {
    return new URL(cleaned, BASE_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  if (!value || typeof value !== "string") return "";
  return cheerio
    .load(value)
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: requestHeaders,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function addCandidate(map, title, url, published = null) {
  const normalizedUrl = normalizeUrl(url);
  const cleanedTitle = cleanText(title);

  if (
    !normalizedUrl ||
    !normalizedUrl.includes("/board/update/view") ||
    !normalizedUrl.includes("articleId=") ||
    cleanedTitle.length < 4
  ) {
    return;
  }

  map.set(normalizedUrl, {
    title: cleanedTitle.slice(0, 250),
    url: normalizedUrl,
    published,
  });
}

function walkJson(value, candidates) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, candidates);
    return;
  }

  if (typeof value !== "object") return;

  const articleId =
    value.articleId ??
    value.article_id ??
    value.articleNo ??
    value.article_no ??
    value.id;

  const title =
    value.title ??
    value.subject ??
    value.articleTitle ??
    value.article_title ??
    value.name;

  const explicitUrl =
    value.url ??
    value.link ??
    value.href ??
    value.articleUrl ??
    value.article_url;

  const published =
    value.publishDate ??
    value.publishedAt ??
    value.createDate ??
    value.createdAt ??
    value.registerDate ??
    null;

  if (explicitUrl && title) {
    addCandidate(candidates, title, explicitUrl, published);
  }

  if (articleId && title) {
    const id = String(articleId);
    if (/^[a-f0-9]{16,}$/i.test(id)) {
      addCandidate(
        candidates,
        title,
        `/ko-kr/board/update/view?articleId=${id}`,
        published,
      );
    }
  }

  for (const nested of Object.values(value)) {
    walkJson(nested, candidates);
  }
}

function extractFromJsonScripts($, candidates) {
  $("script").each((_index, element) => {
    const raw = $(element).html()?.trim();
    if (!raw) return;

    // application/json, __NEXT_DATA__, Apollo/React 상태 JSON 등을 처리합니다.
    const attempts = [raw];

    // 일부 사이트는 JSON을 문자열 안에 한 번 더 이스케이프합니다.
    attempts.push(
      raw
        .replaceAll("\\/", "/")
        .replaceAll("\\u0026", "&")
        .replaceAll('\\"', '"'),
    );

    for (const text of attempts) {
      try {
        walkJson(JSON.parse(text), candidates);
      } catch {
        // 일반 JavaScript 스크립트는 JSON.parse가 실패하는 것이 정상입니다.
      }
    }
  });
}

function extractFromRawHtml(html, candidates) {
  const decoded = html
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&");

  // 링크 주변의 텍스트를 제목으로 사용합니다.
  const linkRegex =
    /(?:https:\/\/aion2\.plaync\.com)?(\/ko-kr\/board\/update\/view\?articleId=([a-f0-9]+))/gi;

  for (const match of decoded.matchAll(linkRegex)) {
    const url = match[1];
    const position = match.index ?? 0;
    const around = decoded.slice(
      Math.max(0, position - 900),
      Math.min(decoded.length, position + 900),
    );

    const titlePatterns = [
      /"(?:title|subject|articleTitle|article_title)"\s*:\s*"([^"]{4,250})"/i,
      /<(?:h1|h2|h3|strong|span|p)[^>]*>([^<]{4,250})<\/(?:h1|h2|h3|strong|span|p)>/i,
      /\[안내\][^"<>{]{3,200}/i,
    ];

    let title = "";
    for (const pattern of titlePatterns) {
      const titleMatch = around.match(pattern);
      if (titleMatch) {
        title = titleMatch[1] ?? titleMatch[0];
        break;
      }
    }

    addCandidate(candidates, title, url);
  }

  // articleId와 제목이 같은 JSON 객체 안에 있는 경우를 별도로 처리합니다.
  const objectRegex =
    /\{[^{}]{0,1800}?"articleId"\s*:\s*"([a-f0-9]+)"[^{}]{0,1800}?\}/gi;

  for (const objectMatch of decoded.matchAll(objectRegex)) {
    const block = objectMatch[0];
    const articleId = objectMatch[1];
    const titleMatch = block.match(
      /"(?:title|subject|articleTitle|article_title)"\s*:\s*"([^"]{4,250})"/i,
    );

    if (titleMatch) {
      addCandidate(
        candidates,
        titleMatch[1],
        `/ko-kr/board/update/view?articleId=${articleId}`,
      );
    }
  }
}

function extractUpdatePosts(html) {
  const $ = cheerio.load(html);
  const candidates = new Map();

  // 1. 일반 링크
  $('a[href*="/board/update/view"]').each((_index, element) => {
    const href = $(element).attr("href");
    const title =
      $(element).attr("title") ||
      $(element).find("[title]").first().attr("title") ||
      $(element).text();

    addCandidate(candidates, title, href);
  });

  // 2. JSON-LD
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      walkJson(JSON.parse($(element).html() ?? ""), candidates);
    } catch {
      // 잘못된 JSON-LD는 건너뜁니다.
    }
  });

  // 3. Next.js/React 상태 데이터
  extractFromJsonScripts($, candidates);

  // 4. HTML 내부 이스케이프 문자열
  extractFromRawHtml(html, candidates);

  return [...candidates.values()].slice(0, 30);
}

async function enrichPost(post) {
  try {
    const html = await fetchHtml(post.url);
    const $ = cheerio.load(html);

    const title =
      cleanText($('meta[property="og:title"]').attr("content")) ||
      cleanText($("h1").first().text()) ||
      post.title;

    const description =
      cleanText($('meta[property="og:description"]').attr("content")) ||
      cleanText($('meta[name="description"]').attr("content")) ||
      cleanText($("article").first().text()).slice(0, 900);

    const image =
      normalizeUrl($('meta[property="og:image"]').attr("content")) ||
      normalizeUrl($('meta[name="twitter:image"]').attr("content"));

    const published =
      $('meta[property="article:published_time"]').attr("content") ||
      $("time").first().attr("datetime") ||
      post.published ||
      null;

    return {
      ...post,
      title,
      description: description.slice(0, 900),
      image,
      published,
    };
  } catch (error) {
    console.warn("상세 정보 읽기 실패:", post.url, error.message);
    return {
      ...post,
      description: "",
      image: null,
      published: post.published ?? null,
    };
  }
}

async function getAlreadyPostedUrls(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const urls = new Set();

  for (const message of messages.values()) {
    for (const embed of message.embeds) {
      if (embed.url) urls.add(embed.url);
    }
  }

  return urls;
}

function makeEmbed(post) {
  const embed = new EmbedBuilder()
    .setColor(0x8f6cff)
    .setAuthor({ name: "AION2 공식 업데이트" })
    .setTitle(post.title)
    .setURL(post.url)
    .setDescription(
      post.description ||
        "새로운 아이온2 업데이트 노트가 등록되었습니다. 원문에서 자세한 내용을 확인하세요.",
    )
    .addFields({
      name: "🔗 원문 보기",
      value: `[아이온2 공식 홈페이지에서 확인하기](${post.url})`,
    })
    .setFooter({ text: "AION2 • PLAYNC" });

  const date = post.published ? new Date(post.published) : new Date();
  if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);
  if (post.image) embed.setImage(post.image);

  return embed;
}

let checking = false;
let firstSuccessfulCheck = true;

async function checkUpdates() {
  if (checking) return;
  checking = true;

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased()) {
      throw new Error("DISCORD_CHANNEL_ID가 텍스트 채널이 아닙니다.");
    }

    const me = channel.guild?.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    const required = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.ReadMessageHistory,
    ];

    if (
      permissions &&
      required.some((permission) => !permissions.has(permission))
    ) {
      throw new Error(
        "봇에 채널 보기, 메시지 보내기, 링크 임베드, 메시지 기록 보기 권한이 필요합니다.",
      );
    }

    const html = await fetchHtml(UPDATE_LIST_URL);
    const posts = extractUpdatePosts(html);

    console.log(`업데이트 게시글 후보 ${posts.length}개 발견`);

    if (posts.length === 0) {
      throw new Error(
        "업데이트 게시글을 찾지 못했습니다. 공식 홈페이지 응답 구조를 다시 확인해야 합니다.",
      );
    }

    const postedUrls = await getAlreadyPostedUrls(channel);
    const newPosts = posts.filter((post) => !postedUrls.has(post.url));

    // 최초 실행 시 기존 글이 여러 개 올라오는 것을 막고 최신 후보 1개만 보냅니다.
    const targets = firstSuccessfulCheck
      ? newPosts.slice(0, 1)
      : newPosts.slice(0, 5).reverse();

    for (const post of targets) {
      const enriched = await enrichPost(post);
      await channel.send({ embeds: [makeEmbed(enriched)] });
      console.log("게시 완료:", enriched.title);
    }

    firstSuccessfulCheck = false;
    console.log(
      `[${new Date().toISOString()}] 확인 완료. 새 글 ${targets.length}개`,
    );
  } catch (error) {
    console.error("업데이트 확인 실패:", error);
  } finally {
    checking = false;
  }
}

client.once("clientReady", async () => {
  console.log(`${client.user.tag} 로그인 완료`);
  await checkUpdates();
  setInterval(checkUpdates, intervalMinutes * 60 * 1000);
});

client.login(token);
