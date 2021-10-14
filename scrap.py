import asyncio
import datetime
import pandas as pd
from pyppeteer import launch
from decouple import config

async def main():
    LINKED_IN_USERNAME = config('LINKED_IN_USERNAME')
    LINKED_IN_PASSWORD = config('LINKED_IN_PASSWORD')
    if not LINKED_IN_USERNAME:
      raise Exception("Please specify LINKED_IN_USERNAME in the env.local file.")
    if not LINKED_IN_PASSWORD:
      raise Exception("Please specify LINKED_IN_PASSWORD in the env.local file.")

    result = []
    inputDf = pd.read_csv('data/input.csv')
    browser = await launch({ 'headless': True })
    page = await browser.newPage()
    await page.goto('https://www.linkedin.com/login', {
        'waitUntil': ['load', 'domcontentloaded', 'networkidle0']
    })
    await page.type('#username', LINKED_IN_USERNAME)
    await page.type('#password', LINKED_IN_PASSWORD)
    await page.click('form.login__form button[type=submit]')
    await page.waitForNavigation()
    print('logged in successfully')

    for index, row in inputDf.iterrows():
      linked_in_url = row['linkedin URL']
      print('start processing', linked_in_url)
      await page.goto(linked_in_url, {
        'waitUntil': ['load', 'domcontentloaded']
      })
      await page.waitForSelector('#main')
      await page.waitFor(100)
      await page.evaluate('window.scrollBy(0,600)')
      await page.waitFor(100)
      await page.evaluate('window.scrollBy(0,600)')
      await page.waitFor(400)
      jobs = await page.evaluate('''() => {
        const experienceElements = [
          ...document.querySelectorAll('#experience-section .pv-profile-section'),
        ];
        if (!experienceElements.length) {
          console.log('student has no job');
          return [];
        }
        const getJobStartDate = element => {
          const [startDateText] = element
            .querySelector('.pv-entity__date-range span:nth-child(2)')
            .innerText.split('–');
          return new Date(`${startDateText}GMT`).toISOString();
        };
        const getSingleJobPositionInfo = sectionElement => {
          const [jobPositionElement, , companyNameElement] = [
            ...sectionElement.querySelector('.pv-entity__summary-info').children,
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
            '.pv-entity__company-summary-info span:nth-child(2)',
          ).innerText;
          return jobSectionElements.map(jobSectionElement => {
            const jobStartDate = getJobStartDate(jobSectionElement);
            const jobPositionElement = jobSectionElement.querySelector(
              "h3 span:not([class='visually-hidden'])",
            );
            return {
              companyName,
              jobStartDate,
              jobTitle: jobPositionElement.innerText,
            };
          });
        };
        const getJobPositionInfoList = sectionElement => {
          const jobPositionElements = [
            ...sectionElement.querySelectorAll('.pv-entity__position-group-role-item'),
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
      }''')
      for job in jobs:
          result.append({
              'Firstname': row['Firstname'],
              'Lastname': row['Lastname'],
              'Email': row['Email'],
              'linkedin URL': linked_in_url,
              'Date of Scrape': str(datetime.date.today().isoformat()),
              'Job Title': job['jobTitle'],
              'Employer Name': job['companyName'],
              'Job Start Date': job['jobStartDate'],
          })
      print('record processed', linked_in_url, 'jobs found:', len(jobs))

    await browser.close()
    outputDf = pd.DataFrame(result)
    output_file_name = "data/output.csv"
    outputDf.to_csv(output_file_name, encoding='utf-8', index=False)
    print('DONE')
    print('the result has been saved to', output_file_name, 'file')

asyncio.get_event_loop().run_until_complete(main())
