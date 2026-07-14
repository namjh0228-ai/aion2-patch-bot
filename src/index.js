import express from "express";
import * as cheerio from "cheerio";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField
} from "discord.js";

const UPDATE_LIST_URL =
  "https://aion2.plaync.com/ko-kr/board/update/list";
const BASE_URL = "https://aion2.plaync.com";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const intervalMinutes = Math.max(
  5,
  Number.parseInt(process.env.CHECK_INTERVAL_MINUTES ?? "10", 10) || 10
);

if (!token || !channelId) {
  console.error(
    "필수 환경변수가 없습니다: DISCORD_TOKEN, DISCORD_CHANNEL_ID"
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.8"
};

function normalizeUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: requestHeaders,
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

function extractUpdatePosts(html) {
  const $ = cheerio.load(html);
  const posts = new Map();

  $('a[href*="/board/update/view"]').each((_index, element) => {
    const href = normalizeUrl($(element).attr("href"));
    const title = $(element).text().replace(/\s+/g, " ").trim();

    if (!href || !title || title.length < 4) return;
    posts.set(href, { title, url: href });
  });

  // 사이트 마크업 변경에 대비한 보조 추출
  if (posts.size === 0) {
    const regex =
      /href=["']([^"']*\/board\/update\/view\?articleId=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(regex)) {
      const url = normalizeUrl(match[1]);
      const title = cheerio
        .load(match[2])
        .text()
        .replace(/\s+/g, " ")
        .trim();
      if (url && title) posts.set(url, { title, url });
    }
  }

  return [...posts.values()].slice(0, 20);
}

async function enrichPost(post) {
  try {
    const html = await fetchHtml(post.url);
    const $ = cheerio.load(html);

    const description =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      "";

    const image =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      null;

    const published =
      $('meta[property="article:published_time"]').attr("content") ||
      $("time").first().attr("datetime") ||
      null;

    return {
      ...post,
      description: description.replace(/\s+/g, " ").trim().slice(0, 800),
      image: normalizeUrl(image),
      published
    };
  } catch (error) {
    console.warn("상세 정보 읽기 실패:", post.url, error.message);
    return { ...post, description: "", image: null, published: null };
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
        "새로운 아이온2 업데이트 노트가 등록되었습니다. 원문에서 자세한 내용을 확인하세요."
    )
    .addFields({
      name: "🔗 원문",
      value: `[공식 홈페이지에서 보기](${post.url})`
    })
    .setFooter({ text: "AION2 • PLAYNC" })
    .setTimestamp(post.published ? new Date(post.published) : new Date());

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
    const permissions = me
      ? channel.permissionsFor(me)
      : null;

    const required = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.ReadMessageHistory
    ];

    if (
      permissions &&
      required.some((permission) => !permissions.has(permission))
    ) {
      throw new Error(
        "봇에 채널 보기, 메시지 보내기, 링크 임베드, 메시지 기록 보기 권한이 필요합니다."
      );
    }

    const html = await fetchHtml(UPDATE_LIST_URL);
    const posts = extractUpdatePosts(html);

    if (posts.length === 0) {
      throw new Error(
        "업데이트 게시글을 찾지 못했습니다. 공식 홈페이지 구조가 변경됐을 수 있습니다."
      );
    }

    const postedUrls = await getAlreadyPostedUrls(channel);
    const newPosts = posts.filter((post) => !postedUrls.has(post.url));

    // 처음 실행할 때 기존 글을 여러 개 도배하지 않고 최신 글 1개만 보냅니다.
    const targets = firstSuccessfulCheck
      ? newPosts.slice(0, 1)
      : newPosts.slice(0, 5).reverse();

    for (const post of targets) {
      const enriched = await enrichPost(post);
      await channel.send({ embeds: [makeEmbed(enriched)] });
      console.log("게시 완료:", post.title);
    }

    firstSuccessfulCheck = false;
    console.log(
      `[${new Date().toISOString()}] 확인 완료. 새 글 ${targets.length}개`
    );
  } catch (error) {
    console.error("업데이트 확인 실패:", error);
  } finally {
    checking = false;
  }
}

client.once("ready", async () => {
  console.log(`${client.user.tag} 로그인 완료`);
  await checkUpdates();
  setInterval(checkUpdates, intervalMinutes * 60 * 1000);
});

client.login(token);
