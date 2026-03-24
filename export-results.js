const pa11y = require('pa11y');
const XLSX = require('xlsx'); // Stále potřebujeme pro CSV výstup z JSON, i když ne pro .xlsx soubor
const cheerio = require('cheerio');
const { URL } = require('url');
const fs = require('fs');

// --- Konfigurace ---
const START_WEBSITES_FILE = 'start_websites.txt';
const MAX_CRAWL_DEPTH = 1;
const CSV_FILE = 'wcag_all_websites_results_detail.csv'; // Změněno na CSV
const PA11Y_OPTIONS = {
    reporter: 'json',
    standard: 'WCAG2AAA', // Testuje nyní A, AA i AAA kritéria
    includeWarnings: true,
    includeNotices: true,
    wait: 5000,
};
const MAX_PAGES_TO_CRAWL_PER_WEBSITE = 50;
const CONCURRENCY_LIMIT = 5;

// Konfigurace bodových penalizací za problémy (pro Total_Penalty_Score)
const PENALTIES = {
    error: {
        'WCAG2A': 10,
        'WCAG2AA': 7,
        'WCAG2AAA': 4
    },
    warning: {
        'WCAG2A': 3,
        'WCAG2AA': 2,
        'WCAG2AAA': 1
    },
    notice: { // Notices are not penalized, but still reported
        'WCAG2A': 0,
        'WCAG2AA': 0,
        'WCAG2AAA': 0
    }
};

// --- Konec konfigurace ---

const allIssues = [];

// Funkce pro získání základní domény z URL
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return null;
    }
}

// Funkce pro určení úrovně WCAG z kódu
function getWcagLevel(wcagCode) {
    if (wcagCode.includes('WCAG2A')) return 'WCAG2A';
    if (wcagCode.includes('WCAG2AA')) return 'WCAG2AA';
    if (wcagCode.includes('WCAG2AAA')) return 'WCAG2AAA';
    return 'UNKNOWN';
}

// NOVÁ FUNKCE: Vyhodnotí stránku a vrátí skóre, rating a další metriky
function evaluatePageAccessibility(issues) {
    let totalPenaltyScore = 0;
    let automatedAAPass = true; // Předpokládáme, že stránka prošla (0 A/AA chyb)
    let aaaIssueCount = 0;

    const errorCountA = 0;
    const errorCountAA = 0;

    issues.forEach(issue => {
        const type = issue.type;
        const level = getWcagLevel(issue.code);

        // Přiřazení bodů pro Total_Penalty_Score
        if (PENALTIES[type] && PENALTIES[type][level] !== undefined) {
            totalPenaltyScore += PENALTIES[type][level];
        }

        // Kontrola pro Automated_AA_Pass
        if (type === 'error' && (level === 'WCAG2A' || level === 'WCAG2AA')) {
            automatedAAPass = false; // Pokud je nalezena A nebo AA chyba, stránka neprošla
        }

        // AAA_Issue_Count
        if (level === 'WCAG2AAA' && (type === 'error' || type === 'warning')) {
            aaaIssueCount++;
        }
    });

    // Určení ratingu na základě totalPenaltyScore
    let rating;
    if (totalPenaltyScore === 0) {
        rating = "Výborná (žádné automatické problémy)";
    } else if (totalPenaltyScore >= 1 && totalPenaltyScore <= 5) {
        rating = "Velmi dobrá";
    } else if (totalPenaltyScore >= 6 && totalPenaltyScore <= 15) {
        rating = "Dobrá";
    } else if (totalPenaltyScore >= 16 && totalPenaltyScore <= 30) {
        rating = "Potřebuje vylepšení";
    } else { // totalPenaltyScore > 30
        rating = "Špatná / Nepřístupná";
    }

    return {
        totalPenaltyScore,
        automatedAAPass,
        aaaIssueCount,
        rating
    };
}


// Funkce pro procházení JEDNOHO WEBU
async function crawlWebsite(startUrl, baseDomain) {
    const visitedUrls = new Set();
    const urlsToTest = [];
    const queue = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0 && urlsToTest.length < MAX_PAGES_TO_CRAWL_PER_WEBSITE) {
        const { url: currentUrl, depth } = queue.shift();

        if (depth > MAX_CRAWL_DEPTH || visitedUrls.has(currentUrl)) {
            continue;
        }

        try {
            const currentBaseDomain = getBaseUrl(currentUrl);
            if (currentBaseDomain !== baseDomain) {
                continue;
            }

            console.log(`  Crawling (hloubka ${depth}): ${currentUrl}`);
            visitedUrls.add(currentUrl);
            urlsToTest.push(currentUrl);

            const response = await fetch(currentUrl, { timeout: 10000 });
            if (!response.ok) {
                console.warn(`    Chyba HTTP ${response.status} při stahování: ${currentUrl}`);
                continue;
            }

            const html = await response.text();
            const $ = cheerio.load(html);

            $('a').each((i, link) => {
                const href = $(link).attr('href');
                if (href) {
                    try {
                        const absoluteUrl = new URL(href, currentUrl).href;
                        if (
                            getBaseUrl(absoluteUrl) === baseDomain &&
                            !visitedUrls.has(absoluteUrl) &&
                            urlsToTest.length < MAX_PAGES_TO_CRAWL_PER_WEBSITE
                        ) {
                            queue.push({ url: absoluteUrl, depth: depth + 1 });
                        }
                    } catch (e) {
                        // console.warn(`    Neplatný odkaz nalezen: ${href} na ${currentUrl}`);
                    }
                }
            });

        } catch (error) {
            console.error(`  Chyba při crawlingu ${currentUrl}:`, error.message);
        }
    }
    return urlsToTest;
}

// Funkce pro spouštění Pa11y testů s omezením současných běhů
async function runPa11yTestsConcurrently(urls, websiteStartUrl) {
    const promises = [];
    const runningTasks = new Set();

    const waitForOneToFinish = () => new Promise(resolve => {
        const interval = setInterval(() => {
            if (runningTasks.size < CONCURRENCY_LIMIT) {
                clearInterval(interval);
                resolve();
            }
        }, 100);
    });

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];

        if (runningTasks.size >= CONCURRENCY_LIMIT) {
            await waitForOneToFinish();
        }

        const task = async () => {
            console.log(`  Testování (Pa11y) ${runningTasks.size + 1}/${CONCURRENCY_LIMIT} běžících: ${url}...`);
            let pageEvaluation = { // Inicializace, pokud dojde k chybě
                totalPenaltyScore: 0,
                automatedAAPass: false,
                aaaIssueCount: 0,
                rating: 'Chyba při testu'
            };

            try {
                const results = await pa11y(url, PA11Y_OPTIONS);

                pageEvaluation = evaluatePageAccessibility(results.issues);

                if (results.issues && results.issues.length > 0) {
                    // Pro každý problém přidej i skóre a rating stránky, ke které patří
                    results.issues.forEach(issue => {
                        allIssues.push({
                            'Website Root URL': websiteStartUrl,
                            'Tested URL': url,
                            'Document Title': results.documentTitle || 'N/A',
                            'Automated_AA_Pass': pageEvaluation.automatedAAPass, // NOVÉ
                            'Total_Penalty_Score': pageEvaluation.totalPenaltyScore, // NOVÉ
                            'AAA_Issue_Count': pageEvaluation.aaaIssueCount, // NOVÉ
                            'Accessibility_Rating': pageEvaluation.rating, // NOVÉ
                            'Issue_Type': issue.type,
                            'WCAG_Code': issue.code,
                            'Message': issue.message,
                            'Context': issue.context,
                            'Selector': issue.selector,
                            'Runner': issue.runner,
                            'Runner_Extras': JSON.stringify(issue.runnerExtras)
                        });
                    });
                    console.log(`    Nalezeno ${results.issues.length} problémů na ${url}. Skóre: ${pageEvaluation.totalPenaltyScore}, Hodnocení: ${pageEvaluation.rating}`);
                } else {
                    // Pokud nejsou problémy, ale chceme stránku zaznamenat i do Excelu s jejím hodnocením
                    allIssues.push({
                        'Website Root URL': websiteStartUrl,
                        'Tested URL': url,
                        'Document Title': results.documentTitle || 'N/A',
                        'Automated_AA_Pass': pageEvaluation.automatedAAPass,
                        'Total_Penalty_Score': pageEvaluation.totalPenaltyScore,
                        'AAA_Issue_Count': pageEvaluation.aaaIssueCount,
                        'Accessibility_Rating': pageEvaluation.rating,
                        'Issue_Type': 'N/A',
                        'WCAG_Code': 'N/A',
                        'Message': 'Žádné automaticky detekované problémy.',
                        'Context': 'N/A',
                        'Selector': 'N/A',
                        'Runner': 'N/A',
                        'Runner_Extras': 'N/A'
                    });
                    console.log(`    Žádné problémy nenalezeny na ${url}. Skóre: ${pageEvaluation.totalPenaltyScore}, Hodnocení: ${pageEvaluation.rating}`);
                }
            } catch (error) {
                console.error(`    Chyba při testování URL ${url}:`, error.message);
                // V případě chyby záznam s chybovým hodnocením
                allIssues.push({
                    'Website Root URL': websiteStartUrl,
                    'Tested URL': url,
                    'Document Title': 'N/A',
                    'Automated_AA_Pass': pageEvaluation.automatedAAPass,
                    'Total_Penalty_Score': pageEvaluation.totalPenaltyScore,
                    'AAA_Issue_Count': pageEvaluation.aaaIssueCount,
                    'Accessibility_Rating': 'Chyba při testu', // Speciální hodnocení
                    'Issue_Type': 'Error (Pa11y Failed)',
                    'WCAG_Code': 'N/A',
                    'Message': `Nepodařilo se otestovat stránku: ${error.message}`,
                    'Context': 'N/A',
                    'Selector': 'N/A',
                    'Runner': 'N/A',
                    'Runner_Extras': 'N/A'
                });
            }
        };

        const promise = task();
        runningTasks.add(promise);
        promise.finally(() => runningTasks.delete(promise));
        promises.push(promise);
    }
    await Promise.all(promises);
}


// Hlavní funkce pro spuštění celého procesu
async function main() {
    console.log('Načítání počátečních URL z ' + START_WEBSITES_FILE + '...');
    let startUrls;
    try {
        const data = fs.readFileSync(START_WEBSITES_FILE, 'utf8');
        startUrls = data.split('\n').map(url => url.trim()).filter(url => url.length > 0);
        if (startUrls.length === 0) {
            console.error(`Soubor '${START_WEBSITES_FILE}' neobsahuje žádné URL adresy.`);
            return;
        }
        console.log(`Nalezeno ${startUrls.length} webových stránek k prohledání.`);
    } catch (error) {
        console.error(`Chyba při čtení souboru '${START_WEBSITES_FILE}':`, error.message);
        return;
    }

    for (const websiteStartUrl of startUrls) {
        const baseDomain = getBaseUrl(websiteStartUrl);
        if (!baseDomain) {
            console.error(`Přeskočena neplatná počáteční URL: ${websiteStartUrl}`);
            continue;
        }
        console.log(`\n--- Spouštění pro web: ${websiteStartUrl} ---`);
        console.log(`  Crawling webu (kořenová doména: ${baseDomain}, hloubka: ${MAX_CRAWL_DEPTH}, max stránek: ${MAX_PAGES_TO_CRAWL_PER_WEBSITE})...`);

        const urlsToTest = await crawlWebsite(websiteStartUrl, baseDomain);
        console.log(`  Crawler dokončen pro ${websiteStartUrl}. Nalezeno ${urlsToTest.length} URL adres pro testování.`);

        if (urlsToTest.length > 0) {
            console.log(`  Spouštění Pa11y testů pro ${urlsToTest.length} URL na webu ${websiteStartUrl}...`);
            await runPa11yTestsConcurrently(urlsToTest, websiteStartUrl);
        } else {
            console.log(`  Žádné URL adresy k testování na webu ${websiteStartUrl}.`);
        }
    }

    if (allIssues.length === 0) {
        console.log('\nŽádné problémy přístupnosti nebyly nalezeny na žádné z testovaných stránek.');
        return;
    }

    // Převod dat do formátu pro CSV
    const worksheet = XLSX.utils.json_to_sheet(allIssues);
    const csv = XLSX.utils.sheet_to_csv(worksheet);

    // Uložení do CSV souboru
    try {
        fs.writeFileSync(CSV_FILE, csv, 'utf8');
        console.log(`\nVýsledky byly úspěšně uloženy do souboru: ${CSV_FILE}`);
    } catch (error) {
        console.error(`Chyba při ukládání CSV souboru:`, error.message);
    }

    // Volitelné: Uložení do JSON souboru (pro budoucí programové zpracování)
    // const JSON_FILE = 'wcag_all_websites_results_detail.json';
    // try {
    //     fs.writeFileSync(JSON_FILE, JSON.stringify(allIssues, null, 2), 'utf8');
    //     console.log(`Výsledky byly úspěšně uloženy také do souboru: ${JSON_FILE}`);
    // } catch (error) {
    //     console.error(`Chyba při ukládání JSON souboru:`, error.message);
    // }
}

// Spuštění hlavního procesu
main();