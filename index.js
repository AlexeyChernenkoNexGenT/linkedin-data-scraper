const fs = require("fs");
const puppeteer = require("puppeteer");
const parser = require("csv-parse/lib/sync");
const stringify = require("csv-stringify/lib/sync");

const {
  LINKED_IN_ACCOUNTS,
  INPUT_FILE_PATH,
  OUTPUT_FILE_PATH,
  LINKEDIN_URL_CSV_COLUMN_NAME,
  MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT,
  DELAY_BETWEEN_REQUESTS_MS,
} = process.env;

const MIN_DELAY_BETWEEN_REQUESTS_MS = Number(DELAY_BETWEEN_REQUESTS_MS);
const MAX_DELAY_BETWEEN_REQUESTS_MS = MIN_DELAY_BETWEEN_REQUESTS_MS * 1.2;
const URL_PROTOCOL_SUB_DOMAIN_REGEX = /^https:\/\/www\./gim;
const LINKEDIN_URL_PATH_REGEX = /linkedin\.com\/in\/.+/gim;

const log = (...params) =>
  console.log(`[${new Date().toISOString()}]`, ...params);

const chunk = (inputArray, perChunk) =>
  inputArray.reduce((resultArray, item, index) => {
    const chunkIndex = Math.floor(index / perChunk);
    if (!resultArray[chunkIndex]) {
      resultArray[chunkIndex] = []; // start a new chunk
    }
    resultArray[chunkIndex].push(item);
    return resultArray;
  }, []);

const getRandomInt = (min, max) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
};

const parseCsvFile = (path) =>
  parser(fs.readFileSync(path).toString("utf8"), {
    delimiter: ",",
    quote: '"',
    columns: true,
    trim: true,
  });

const saveCsvFile = (path, records) =>
  fs.writeFileSync(path, stringify(records, { header: true }));

const msToTime = (duration) => {
  var milliseconds = Math.floor((duration % 1000) / 100),
    seconds = Math.floor((duration / 1000) % 60),
    minutes = Math.floor((duration / (1000 * 60)) % 60),
    hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
  hours = hours < 10 ? "0" + hours : hours;
  minutes = minutes < 10 ? "0" + minutes : minutes;
  seconds = seconds < 10 ? "0" + seconds : seconds;
  return hours + ":" + minutes + ":" + seconds + "." + milliseconds;
};

const assertAccountActive = async (page) => {
  const isAccountBanned = await page.evaluate(() => {
    const headerElement = document.querySelector("main > h1:first-child");
    return (
      headerElement &&
      headerElement.innerText === "Your account has been restricted"
    );
  });
  if (isAccountBanned) {
    throw new Error("The account has been banned.");
  }
};

const isCaptchaRequired = async (page) =>
  (await page.$("#captchaInternalPath")) !== null;

const login = async (page, username, password) => {
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("form.login__form button[type=submit]");
  await page.waitForNavigation();
  await page.waitForTimeout(500);
  await assertAccountActive(page);
  log("logged in successfully");
};

const scrapePage = async (page, index, user, threadId) => {
  const linkedInUrl = user[LINKEDIN_URL_CSV_COLUMN_NAME];
  log(`[ThreadID=${threadId}][${index}] start processing`, linkedInUrl);
  await page.goto(linkedInUrl, {
    waitUntil: ["load", "domcontentloaded"],
  });
  await page.waitForTimeout(1000);
  await page.evaluate("window.scrollBy(0,600)");
  await page.waitForTimeout(500);
  await page.evaluate("window.scrollBy(0,600)");
  const delayMs = getRandomInt(
    MIN_DELAY_BETWEEN_REQUESTS_MS,
    MAX_DELAY_BETWEEN_REQUESTS_MS
  );
  log(`[ThreadID=${threadId}] waiting`, msToTime(delayMs));
  await page.waitForTimeout(delayMs);
  const jobs = await page.evaluate(() => {
    const experienceElements = [
      ...document.querySelectorAll("#experience-section .pv-profile-section"),
    ];
    if (!experienceElements.length) {
      console.log("student has no job");
      return [];
    }
    const getJobStartDate = (element) => {
      const [startDateText] = element
        .querySelector(".pv-entity__date-range span:nth-child(2)")
        .innerText.split("–");
      return new Date(`${startDateText}GMT`).toISOString();
    };
    const getSingleJobPositionInfo = (sectionElement) => {
      const [jobPositionElement, , companyNameElement] = [
        ...sectionElement.querySelector(".pv-entity__summary-info").children,
      ];
      const jobStartDate = getJobStartDate(sectionElement);
      return {
        companyName: companyNameElement.firstChild.wholeText.trim(),
        jobTitle: jobPositionElement.innerText,
        jobStartDate,
      };
    };
    const getMultiJobPositionInfo = (sectionElement, jobSectionElements) => {
      const companyName = sectionElement.querySelector(
        ".pv-entity__company-summary-info span:nth-child(2)"
      ).innerText;
      return jobSectionElements.map((jobSectionElement) => {
        const jobStartDate = getJobStartDate(jobSectionElement);
        const jobPositionElement = jobSectionElement.querySelector(
          "h3 span:not([class='visually-hidden'])"
        );
        return {
          companyName,
          jobStartDate,
          jobTitle: jobPositionElement.innerText,
        };
      });
    };
    const getJobPositionInfoList = (sectionElement) => {
      const jobPositionElements = [
        ...sectionElement.querySelectorAll(
          ".pv-entity__position-group-role-item"
        ),
      ];
      if (jobPositionElements.length) {
        // Process multi job positions per company.
        return getMultiJobPositionInfo(sectionElement, jobPositionElements);
      }
      // Process single company job position.
      return [getSingleJobPositionInfo(sectionElement)];
    };
    const [theMostRecentJobPosition] = experienceElements;
    return getJobPositionInfoList(theMostRecentJobPosition);
  });
  // Navigate to the home page just to simulate human behavior.
  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: ["load", "domcontentloaded"],
  });
  await page.waitForTimeout(3000);
  log(
    `[ThreadID=${threadId}][${index}] record processed`,
    linkedInUrl,
    "jobs found:",
    jobs.length
  );
  return jobs.map((job) => ({
    ...user,
    "Date of Scrape": new Date().toISOString(),
    "Job Title": job["jobTitle"],
    "Employer Name": job["companyName"],
    "Job Start Date": job["jobStartDate"],
  }));
};

const validate = (users) =>
  users
    .filter((user) => {
      const url = user[LINKEDIN_URL_CSV_COLUMN_NAME];
      if (!url || !url.match(LINKEDIN_URL_PATH_REGEX)) {
        log("the record has invalid url", user);
        return false;
      }
      return true;
    })
    .map((user) => {
      const url = user[LINKEDIN_URL_CSV_COLUMN_NAME];
      let newUrl = url;
      if (!URL_PROTOCOL_SUB_DOMAIN_REGEX.test(url)) {
        const path = url.match(LINKEDIN_URL_PATH_REGEX);
        newUrl = `https://www.${path}`;
      }
      return {
        ...user,
        [LINKEDIN_URL_CSV_COLUMN_NAME]: newUrl,
      };
    });

const scrapeUsingAccount = async (userName, password, users, threadId) => {
  if (!users.length) {
    return;
  }
  if (!userName) {
    throw new Error("UserName is required");
  }
  if (!password) {
    throw new Error("Password is required");
  }
  const records = [];
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setCacheEnabled(true);
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: ["load", "domcontentloaded", "networkidle0"],
  });
  await login(page, userName, password);

  for (let i = 0; i < users.length; i++) {
    const index = i + 1;
    if (await isCaptchaRequired(page)) {
      log(
        `[ThreadID=${threadId}][${index}][${userName}] !!! PROCESSING IS STOPPED !!! Captcha is required.`
      );
      break;
    }
    records.push(...(await scrapePage(page, index, users[i], threadId)));
  }

  await browser.close();

  return records;
};

const main = async () => {
  if (!MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT) {
    throw new Error(
      "Please specify MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT in the env.local file."
    );
  }
  const batchSize = Number(MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT);
  if (!LINKED_IN_ACCOUNTS) {
    throw new Error("Please specify LINKED_IN_ACCOUNTS in the env.local file.");
  }
  const accounts = JSON.parse(LINKED_IN_ACCOUNTS);
  if (!accounts.length) {
    throw new Error(
      "Please specify at least one linkedIn account in JSON format. Use LINKED_IN_ACCOUNTS environment variable in the env.local file."
    );
  }
  const users = validate(parseCsvFile(INPUT_FILE_PATH));
  if (!users.length) {
    log("There's nothing to process. The input CSV file has no rows");
    return;
  }
  log("found user to process:", users.length);
  if (Math.ceil(users.length / batchSize) > accounts.length) {
    throw new Error(
      `There's not enough linkedIn accounts specified to process ${users.length} users. Each linkedIn account can process up to ${MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT} profiles.`
    );
  }

  const batches = chunk(users, batchSize);
  const records = (
    await Promise.all(
      batches.map((batch, batchIndex) => {
        const { userName, password } = accounts[batchIndex];
        return scrapeUsingAccount(userName, password, batch, batchIndex + 1);
      })
    )
  ).flat();

  saveCsvFile(OUTPUT_FILE_PATH, records);
  log("the result has been saved to", OUTPUT_FILE_PATH, "file");
};

(async () => {
  const startTime = Date.now();
  try {
    await main();
    log("DONE");
  } catch (err) {
    console.error(err);
  } finally {
    const endTime = Date.now();
    log("Elapsed:", msToTime(endTime - startTime));
  }
})();
