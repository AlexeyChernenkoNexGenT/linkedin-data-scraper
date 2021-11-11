const fs = require("fs");
const puppeteer = require("puppeteer");
const parser = require("csv-parse/lib/sync");
const stringify = require("csv-stringify/lib/sync");

const {
  LINKED_IN_USERNAME,
  LINKED_IN_PASSWORD,
  INPUT_FILE_PATH,
  OUTPUT_FILE_PATH,
  LINKEDIN_URL_CSV_COLUMN_NAME,
} = process.env;

const URL_PROTOCOL_SUB_DOMAIN_REGEX = /^https:\/\/www\./gim;
const LINKEDIN_URL_PATH_REGEX = /linkedin\.com\/in\/.+/gim;

const log = (...params) =>
  console.log(`[${new Date().toISOString()}]`, ...params);

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

const login = async (page, username, password) => {
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("form.login__form button[type=submit]");
  await page.waitForNavigation();
  await page.waitForTimeout(500);
  await assertAccountActive(page);
  log("logged in successfully");
};

const scrapePage = async (page, index, user) => {
  const linkedInUrl = user[LINKEDIN_URL_CSV_COLUMN_NAME];
  log(`[${index}] start processing`, linkedInUrl);
  await page.goto(linkedInUrl, {
    waitUntil: ["load", "domcontentloaded"],
  });
  await page.waitForTimeout(1000);
  await assertAccountActive(page);
  await page.evaluate("window.scrollBy(0,600)");
  await page.waitForTimeout(500);
  await page.evaluate("window.scrollBy(0,600)");
  await page.waitForTimeout(getRandomInt(10000, 15000));
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
  log(
    `[${index}] record processed`,
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

const main = async () => {
  if (!LINKED_IN_USERNAME) {
    throw new Error("Please specify LINKED_IN_USERNAME in the env.local file.");
  }
  if (!LINKED_IN_PASSWORD) {
    throw new Error("Please specify LINKED_IN_PASSWORD in the env.local file.");
  }
  const records = [];
  const users = validate(parseCsvFile(INPUT_FILE_PATH));
  if (!users.length) {
    log("There's nothing to process. The input CSV file has no rows");
    return;
  }
  log("found user to process:", users.length);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setCacheEnabled(true);
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: ["load", "domcontentloaded", "networkidle0"],
  });
  await login(page, LINKED_IN_USERNAME, LINKED_IN_PASSWORD);
  await page.screenshot({ path: "login.png" });

  for (let i = 0; i < users.length; i++) {
    records.push(...(await scrapePage(page, i, users[i])));
  }

  await browser.close();

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
