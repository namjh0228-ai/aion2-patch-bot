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
  console.error(
    "필수 환경변수가 없습니다: DISCORD_TOKEN, DISCORD_CHANNEL_ID",
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* Render Web Service용 상태 확인 서버 */
const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("AION2 patch bot is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    botReady: client.isReady(),
    checkedAt: new Date().toISOString(),
  });
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`Health server started on port ${port}.`);
});

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value, UPDATE_LIST_URL);
    url.hash = "";

    /* 추적용 파라미터는 중복 판정에서 제외 */
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        ["ref", "source", "from"].includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function getPostKey(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);

    /* AION2 게시글의 고유 번호를 최우선으로 사용 */
    const articleId =
      url.searchParams.get("articleId") ||
      url.searchParams.get("articleid") ||
      url.searchParams.get("id");

    if (articleId) {
      return `article:${articleId}`;
    }

    /* articleId가 없을 때도 동일 주소를 안정적으로 비교 */
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return normalized;
  }
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
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
      timeout: 60_000,
    });

    await page
      .waitForSelector('a[href*="/board/update/view"]', {
        timeout: 30_000,
      })
      .catch(() => null);

    await page.waitForTimeout(3_000);

    const rawPosts = await page.evaluate(() => {
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
          cleanedTitle.length < 2 ||
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

    const deduped = [];
    const seenKeys = new Set();

    for (const post of rawPosts) {
      const url = normalizeUrl(post.url);
      const key = getPostKey(url);

      if (!url || !key || seenKeys.has(key)) continue;

      seenKeys.add(key);
      deduped.push({
        title: cleanText(post.title),
        url,
      });
    }

    console.log(`업데이트 게시글 후보 ${deduped.length}개 발견`);
    return deduped.slice(0, 30);
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
      timeout: 60_000,
    });

    await page.waitForTimeout(2_000);

    const details = await page.evaluate(() => {
      const meta = (selector) =>
        document.querySelector(selector)?.getAttribute("content") || "";

      return {
        title:
          meta('meta[property="og:title"]') ||
          document.querySelector("h1")?.textContent ||
          document.title ||
          "",
        description:
          meta('meta[property="og:description"]') ||
          meta('meta[name="description"]') ||
          document.querySelector("article")?.textContent ||
          "",
        image:
          meta('meta[property="og:image"]') ||
          meta('meta[name="twitter:image"]') ||
          "",
        published:
          meta('meta[property="article:published_time"]') ||
          document.querySelector("time")?.getAttribute("datetime") ||
          "",
      };
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

async function getAlreadyPostedKeys(channel) {
  const postedKeys = new Set();

  /*
   * 최근 100개만 보는 대신 최대 500개까지 확인합니다.
   * Discord API 호출량을 줄이기 위해 한 번의 확인 주기에서만 실행됩니다.
   */
  let before;
  let fetchedCount = 0;

  while (fetchedCount < 500) {
    const messages = await channel.messages.fetch({
      limit: 100,
      before,
      cache: false,
    });

    if (messages.size === 0) break;

    for (const message of messages.values()) {
      for (const embed of message.embeds) {
        const key = getPostKey(embed.url);
        if (key) postedKeys.add(key);
      }
    }

    fetchedCount += messages.size;
    before = messages.last()?.id;

    if (messages.size < 100) break;
  }

  return postedKeys;
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
    .setFooter({
      text: `AION2 · PLAYNC · ${getPostKey(post.url) ?? "update"}`,
    });

  if (post.image) {
    embed.setImage(post.image);
  }

  if (post.published) {
    const date = new Date(post.published);
    if (!Number.isNaN(date.getTime())) {
      embed.setTimestamp(date);
    }
  }

  return embed;
}

let checking = false;

async function checkUpdates() {
  if (checking) {
    console.log("이전 확인 작업이 진행 중이므로 이번 실행은 생략합니다.");
    return;
  }

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
    if (posts.length === 0) {
      throw new Error(
        "브라우저로 페이지를 열었지만 업데이트 게시글을 찾지 못했습니다.",
      );
    }

    const postedKeys = await getAlreadyPostedKeys(channel);

    /*
     * 게시판 최상단의 최신 글 한 개만 확인합니다.
     * 과거 글이 디스코드에 없더라도 소급해서 올리지 않습니다.
     */
    const latestPost = posts[0];
    const latestKey = getPostKey(latestPost?.url);
    const targets =
      latestPost && latestKey && !postedKeys.has(latestKey)
        ? [latestPost]
        : [];

    let sentCount = 0;

    for (const post of targets) {
      const postKey = getPostKey(post.url);
      if (!postKey || postedKeys.has(postKey)) continue;

      /*
       * 배포가 겹치는 짧은 구간에도 중복을 줄이기 위해
       * 전송 직전에 최신 메시지를 한 번 더 확인합니다.
       */
      const latestMessages = await channel.messages.fetch({
        limit: 20,
        cache: false,
      });

      const latestKeys = new Set();
      for (const message of latestMessages.values()) {
        for (const embed of message.embeds) {
          const key = getPostKey(embed.url);
          if (key) latestKeys.add(key);
        }
      }

      if (latestKeys.has(postKey)) {
        console.log("중복 게시 생략:", post.title);
        postedKeys.add(postKey);
        continue;
      }

      const enriched = await enrichPost(post);

      await channel.send({
        embeds: [makeEmbed(enriched)],
      });

      postedKeys.add(postKey);
      sentCount += 1;
      console.log("게시 완료:", enriched.title);
    }


    console.log(
      `[${new Date().toISOString()}] 확인 완료. 새 글 ${sentCount}개`,
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

  setInterval(() => {
    void checkUpdates();
  }, intervalMinutes * 60 * 1000);
});

client.login(token);
