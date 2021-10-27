const fs = require("fs");
const puppeteer = require("puppeteer");
const parser = require("csv-parse/lib/sync");
const stringify = require("csv-stringify/lib/sync");

const {
  LINKED_IN_USERNAME,
  LINKED_IN_PASSWORD,
  INPUT_FILE_PATH,
  OUTPUT_FILE_PATH,
} = process.env;

const parseCsvFile = (path) =>
  parser(fs.readFileSync(path).toString("utf8"), {
    delimiter: ",",
    quote: '"',
    columns: true,
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

const login = async (page, username, password) => {
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("form.login__form button[type=submit]");
  await page.waitForNavigation();
  console.log("logged in successfully");
};

const scrapePage = async (page, user) => {
  const linkedInUrl = user["linkedin URL"];
  console.log("start processing", linkedInUrl);
  await page.goto(linkedInUrl, {
    waitUntil: ["load", "domcontentloaded"],
  });
  await page.waitForTimeout(800);
  await page.evaluate("window.scrollBy(0,600)");
  await page.waitForTimeout(500);
  await page.evaluate("window.scrollBy(0,600)");
  await page.waitForTimeout(500);
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
  console.log("record processed", linkedInUrl, "jobs found:", jobs.length);
  return jobs.map((job) => ({
    Firstname: user["Firstname"],
    Lastname: user["Lastname"],
    Email: user["Email"],
    "linkedin URL": linkedInUrl,
    "Date of Scrape": new Date().toISOString(),
    "Job Title": job["jobTitle"],
    "Employer Name": job["companyName"],
    "Job Start Date": job["jobStartDate"],
  }));
};

(async () => {
  const startTime = Date.now();
  if (!LINKED_IN_USERNAME) {
    throw new Error("Please specify LINKED_IN_USERNAME in the env.local file.");
  }
  if (!LINKED_IN_PASSWORD) {
    throw new Error("Please specify LINKED_IN_PASSWORD in the env.local file.");
  }
  const records = [];
  const users = parseCsvFile(INPUT_FILE_PATH);
  if (!users.length) {
    console.log("There's nothing to process. The input CSV file has no rows");
    return;
  }
  console.table(users);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: ["load", "domcontentloaded", "networkidle0"],
  });
  await login(page, LINKED_IN_USERNAME, LINKED_IN_PASSWORD);
  await page.screenshot({ path: "login.png" });

  while (users.length) {
    const [user] = users.splice(0, 1);
    records.push(...(await scrapePage(page, user)));
  }

  await browser.close();

  saveCsvFile(OUTPUT_FILE_PATH, records);
  const endTime = Date.now();
  console.log("DONE", msToTime(endTime - startTime));
  console.log("the result has been saved to", OUTPUT_FILE_PATH, "file");
})();
