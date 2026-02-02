import puppeteer from 'puppeteer-core';

async function scrapeJobList() {
  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const linkedinPage = pages.find(p => p.url().includes('linkedin.com/jobs/search'));

  if (!linkedinPage) {
    console.error('No LinkedIn job search page found');
    await browser.disconnect();
    process.exit(1);
  }

  console.log('Extracting from:', linkedinPage.url().substring(0, 60));

  // Scroll to load more jobs
  for (let i = 0; i < 3; i++) {
    await linkedinPage.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 800));
  }

  // Extract jobs from the list view
  const jobs = await linkedinPage.evaluate(() => {
    const results = [];

    // Find job links
    const jobLinks = Array.from(document.querySelectorAll('a'))
      .filter(a => {
        const text = a.textContent?.trim();
        const href = a.href;
        return text && text.length > 5 && text.length < 150 &&
               (href.includes('/jobs/view/') || href.includes('currentJobId'));
      });

    for (const link of jobLinks) {
      const text = link.textContent?.trim();

      // Skip UI elements
      if (!text || text.includes('Save') || text.includes('Apply') || text.includes('Premium')) continue;

      // Get job ID
      let jobId = null;
      const hrefMatch = link.href.match(/\/jobs\/view\/(\d+)/);
      const currentJobMatch = link.href.match(/currentJobId=(\d+)/);
      jobId = hrefMatch?.[1] || currentJobMatch?.[1];

      if (!jobId) continue;

      // Find card container
      let card = link;
      for (let i = 0; i < 8; i++) {
        card = card.parentElement;
        if (!card) break;
        const cardText = card.textContent || '';
        if ((cardText.includes('$') || cardText.includes('ago') || cardText.includes('Promoted')) && cardText.length > 50) break;
      }

      // Extract title - clean up duplicates and whitespace
      let title = text.replace(/\s*with verification\s*/gi, '')
                      .replace(/\n+/g, ' ')
                      .replace(/\s{2,}/g, ' ')
                      .trim();
      // Remove duplicate title (LinkedIn sometimes renders twice)
      const halfLen = Math.floor(title.length / 2);
      const firstHalf = title.substring(0, halfLen).trim();
      const secondHalf = title.substring(halfLen).trim();
      if (firstHalf === secondHalf) {
        title = firstHalf;
      }

      // Extract company - try multiple methods
      let company = 'Unknown';
      if (card) {
        // Method 1: Company link
        const companyLink = card.querySelector('a[href*="/company/"]');
        if (companyLink) {
          company = companyLink.textContent?.trim().replace(/\n/g, ' ').replace(/\s+/g, ' ') || 'Unknown';
        }

        // Method 2: Look for text patterns after title (company usually follows title)
        if (company === 'Unknown') {
          const cardText = card.innerText || '';
          const lines = cardText.split('\n').map(l => l.trim()).filter(l => l && l.length > 1);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip the title line and look for company-like text
            if (line.includes(title.substring(0, 15))) continue;
            // Company is usually 2-50 chars, not a location pattern, not a price
            if (line.length > 2 && line.length < 50 &&
                !line.match(/^\$/) &&
                !line.match(/^(Remote|Hybrid|On-site)/i) &&
                !line.match(/\d+ (day|week|hour|month)/i) &&
                !line.match(/Promoted|Viewed/i)) {
              company = line;
              break;
            }
          }
        }
      }

      // Extract location - cleaner approach
      let location = 'Unknown';
      if (card) {
        const cardText = card.innerText || '';
        const lines = cardText.split('\n').map(l => l.trim()).filter(l => l);

        for (const line of lines) {
          // Skip title, company, salary, time
          if (line.includes(title.substring(0, 15))) continue;
          if (line === company) continue;
          if (line.match(/^\$/)) continue;
          if (line.match(/\d+ (day|week|hour|month)/i)) continue;
          if (line.match(/Promoted|Viewed|benefit|connection/i)) continue;

          // Match location patterns
          const cityStateMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\s*\(?(Hybrid|Remote|On-site)?\)?$/i);
          if (cityStateMatch) {
            location = cityStateMatch[1] + (cityStateMatch[2] ? ` (${cityStateMatch[2]})` : '');
            break;
          }

          // Match just work type
          const workTypeMatch = line.match(/^(Remote|Hybrid|On-site)$/i);
          if (workTypeMatch) {
            location = workTypeMatch[1];
            break;
          }

          // Match "City, ST (Hybrid)" format
          const fullMatch = line.match(/^([A-Z][a-z\s]+,\s*[A-Z]{2})\s*\((Hybrid|Remote|On-site)\)$/i);
          if (fullMatch) {
            location = `${fullMatch[1]} (${fullMatch[2]})`;
            break;
          }
        }
      }

      // Extract salary
      let salary = null;
      if (card) {
        const salaryMatch = card.textContent?.match(/\$[\d,]+(?:K)?(?:\/yr)?\s*[-–]\s*\$[\d,]+(?:K)?/i);
        if (salaryMatch) salary = salaryMatch[0];
      }

      results.push({
        jobId,
        title: title.substring(0, 100),
        company: company.substring(0, 60),
        location,
        salary,
        jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
      });
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(job => {
      if (seen.has(job.jobId)) return false;
      seen.add(job.jobId);
      return true;
    });
  });

  console.log(`\nExtracted ${jobs.length} unique jobs:\n`);

  for (const job of jobs) {
    const salaryStr = job.salary ? job.salary : 'No salary';
    console.log(`- ${job.title}`);
    console.log(`  @ ${job.company} | ${job.location} | ${salaryStr}\n`);
  }

  console.log('=== JSON ===');
  console.log(JSON.stringify(jobs, null, 2));

  await browser.disconnect();
  return jobs;
}

scrapeJobList().catch(console.error);
