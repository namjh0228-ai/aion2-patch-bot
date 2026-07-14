import express from "express";
import { chromium } from "playwright";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
} from "discord.js";

const UPDATE_LIST_URL =
  "https://aion2.plaync.com/ko-kr/board/update/list";

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

function normalizeUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, UPDATE_LIST_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

async function getUpdatePosts() {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      viewport: { width: 1440, height: 1200 },
    });

    await page.goto(UPDATE_LIST_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 게시판 데이터가 자바스크립트로 불러와질 시간을 줍니다.
    await page
      .waitForSelector('a[href*="/board/update/view"]', { timeout: 30000 })
      .catch(() => null);

    await page.waitForTimeout(3000);

    const posts = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      for (const link of document.querySelectorAll(
        'a[href*="/board/update/view"]',
      )) {
        const href = link.href;
        const title =
          link.getAttribute("title") ||
          link.querySelector("[title]")?.getAttribute("title") ||
          link.textContent ||
          "";

        const cleanedTitle = title.replace(/\s+/g, " ").trim();

        if (
          !href ||
          !href.includes("articleId=") ||
          cleanedTitle.length < 4 ||
          seen.has(href)
        ) {
          continue;
        }

        seen.add(href);
        results.push({
          title: cleanedTitle.slice(0, 250),
          url: href,
        });
      }

      return results;
    });

    if (posts.length === 0) {
      // 문제 확인을 위해 렌더링된 페이지 제목과 URL을 로그에 남깁니다.
      console.log("렌더링된 페이지 제목:", await page.title());
      console.log("현재 페이지 URL:", page.url());
    }

    return posts.slice(0, 30);
  } finally {
    await browser.close();
  }
}

async function enrichPost(post) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });

    await page.goto(post.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    const details = await page.evaluate(() => {
      const meta = (selector) =>
        document.querySelector(selector)?.getAttribute("content") || "";

      const title =
        meta('meta[property="og:title"]') ||
        document.querySelector("h1")?.textContent ||
        document.title ||
        "";

      const description =
        meta('meta[property="og:description"]') ||
        meta('meta[name="description"]') ||
        document.querySelector("article")?.textContent ||
        "";

      const image =
        meta('meta[property="og:image"]') ||
        meta('meta[name="twitter:image"]') ||
        "";

      const published =
        meta('meta[property="article:published_time"]') ||
        document.querySelector("time")?.getAttribute("datetime") ||
        "";

      return { title, description, image, published };
    });

    return {
      ...post,
      title: cleanText(details.title) || post.title,
      description: cleanText(details.description).slice(0, 900),
      image: normalizeUrl(details.image),
      published: details.published || null,
    };
  } catch (error) {
    console.warn("상세 정보 읽기 실패:", post.url, error.message);
    return {
      ...post,
      description: "",
      image: null,
      published: null,
    };
  } finally {
    await browser.close();
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

  if (post.image) embed.setImage(post.image);

  const date = post.published ? new Date(post.published) : new Date();
  if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);

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

    const posts = await getUpdatePosts();
    console.log(`업데이트 게시글 후보 ${posts.length}개 발견`);

    if (posts.length === 0) {
      throw new Error(
        "브라우저로 페이지를 열었지만 업데이트 게시글을 찾지 못했습니다.",
      );
    }

    const postedUrls = await getAlreadyPostedUrls(channel);
    const newPosts = posts.filter((post) => !postedUrls.has(post.url));

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
