const fs = require('fs');
const parse = require('csv-parse').parse; // pro parsování CSV
const { URL } = require('url');

// --- Konfigurace pro souhrnný report ---
const DETAIL_CSV_FILE = 'wcag_all_websites_results_detail.csv'; // Název detailního CSV souboru z prvního skriptu
const SUMMARY_REPORT_FILE = 'wcag_domain_summary_report.txt'; // Výstupní soubor pro souhrnný report
// --- Konec konfigurace ---

async function generateDomainSummary() {
    console.log(`Načítání detailních výsledků z ${DETAIL_CSV_FILE}...`);
    let records;
    try {
        const fileContent = fs.readFileSync(DETAIL_CSV_FILE, 'utf8');
        records = await new Promise((resolve, reject) => {
            parse(fileContent, {
                columns: true, // Automaticky použije první řádek jako názvy sloupců
                skip_empty_lines: true
            }, (err, output) => {
                if (err) reject(err);
                resolve(output);
            });
        });
    } catch (error) {
        console.error(`Chyba při čtení nebo parsování ${DETAIL_CSV_FILE}:`, error.message);
        if (error.code === 'ENOENT') {
            console.error('Ujistěte se, že jste spustili první skript a vygenerovali soubor s detaily.');
        }
        return;
    }

    if (records.length === 0) {
        console.log('Detailní CSV soubor neobsahuje žádná data.');
        return;
    }

    const domainData = {}; // Objekt pro uložení agregovaných dat pro každou doménu

    records.forEach(row => {
        const rootUrl = row['Website Root URL'];
        const testedUrl = row['Tested URL'];
        const automatedAAPass = String(row['Automated_AA_Pass']).toLowerCase() === 'true'; // Převedeme string 'true'/'false' na boolean
        const totalPenaltyScore = parseInt(row['Total_Penalty_Score'], 10) || 0;
        const aaaIssueCount = parseInt(row['AAA_Issue_Count'], 10) || 0;
        const issueType = row['Issue_Type'];
        const wcagCode = row['WCAG_Code'];

        if (!domainData[rootUrl]) {
            domainData[rootUrl] = {
                pagesTested: new Set(), // Použijeme Set pro unikátní URL
                pagesPassingAAErrors: 0,
                totalPages: 0, // Bude se aktualizovat z velikosti Setu na konci
                totalPenaltyScoreSum: 0,
                totalAAAIssuesSum: 0,
                totalA_AA_Errors: 0,
                totalWarnings: 0,
                totalNotices: 0,
                pageRatings: {} // Pro ukládání hodnocení jednotlivých stránek
            };
        }

        // Zaznamenáváme stránky a jejich hodnocení
        if (!domainData[rootUrl].pagesTested.has(testedUrl)) {
            domainData[rootUrl].pagesTested.add(testedUrl);
            if (automatedAAPass) {
                domainData[rootUrl].pagesPassingAAErrors++;
            }
            domainData[rootUrl].totalPenaltyScoreSum += totalPenaltyScore;
            domainData[rootUrl].totalAAAIssuesSum += aaaIssueCount;
        }

        // Agregace chyb a varování pro celou doménu
        if (issueType === 'Error (Pa11y Failed)') { // Chyba při testu, ne WCAG issue
            // Můžeme ji ignorovat pro WCAG počty, ale zaznamenat jinak
        } else if (issueType !== 'N/A') { // Skutečný WCAG problém
            const level = getWcagLevel(wcagCode);
            if (issueType === 'error' && (level === 'WCAG2A' || level === 'WCAG2AA')) {
                domainData[rootUrl].totalA_AA_Errors++;
            }
            if (issueType === 'warning') {
                domainData[rootUrl].totalWarnings++;
            }
            if (issueType === 'notice') {
                domainData[rootUrl].totalNotices++;
            }
        }
    });

    let reportContent = '';
    reportContent += `*** Souhrnný Report Přístupnosti Webových Domén ***\n`;
    reportContent += `Datum: ${new Date().toLocaleString()}\n`;
    reportContent += `--------------------------------------------------\n\n`;

    for (const rootUrl in domainData) {
        const data = domainData[rootUrl];
        data.totalPages = data.pagesTested.size; // Aktuální počet unikátních stránek

        const percentagePassingAA = data.totalPages > 0
            ? ((data.pagesPassingAAErrors / data.totalPages) * 100).toFixed(2)
            : 0;
        const averagePenaltyScore = data.totalPages > 0
            ? (data.totalPenaltyScoreSum / data.totalPages).toFixed(2)
            : 0;
        const averageAAAIssues = data.totalPages > 0
            ? (data.totalAAAIssuesSum / data.totalPages).toFixed(2)
            : 0;

        // Zde by bylo možné implementovat komplexnější "Domain Rating"
        // např. "Vyhovující" pokud % Pages Passing AA-Errors > 90% a celkový počet A/AA chyb < 5
        let domainRating = "N/A";
        if (percentagePassingAA == 100 && data.totalA_AA_Errors == 0) {
            domainRating = "Výborná (žádné A/AA chyby na žádné stránce)";
        } else if (percentagePassingAA >= 80 && data.totalA_AA_Errors < 10) {
            domainRating = "Dobrá (většina stránek OK, málo A/AA chyb)";
        } else if (percentagePassingAA >= 50 && data.totalA_AA_Errors < 30) {
            domainRating = "Potřebuje výrazné zlepšení";
        } else {
            domainRating = "Nepřístupná (mnoho A/AA chyb)";
        }


        reportContent += `Webová Doména: ${rootUrl}\n`;
        reportContent += `  Celkový počet otestovaných stránek: ${data.totalPages}\n`;
        reportContent += `  % Stránek, které prošly (0 A/AA chyb): ${percentagePassingAA}%\n`;
        reportContent += `  Celkový počet A/AA chyb (na celém webu): ${data.totalA_AA_Errors}\n`;
        reportContent += `  Celkový počet varování (na celém webu): ${data.totalWarnings}\n`;
        reportContent += `  Celkový počet upozornění (na celém webu): ${data.totalNotices}\n`;
        reportContent += `  Celkový počet AAA problémů (na celém webu): ${data.totalAAAIssuesSum}\n`;
        reportContent += `  Průměrné penalizační skóre na stránku: ${averagePenaltyScore}\n`;
        reportContent += `  **Celkové hodnocení domény:** ${domainRating}\n`;
        reportContent += `--------------------------------------------------\n\n`;
    }

    try {
        fs.writeFileSync(SUMMARY_REPORT_FILE, reportContent, 'utf8');
        console.log(`\nSouhrnný report byl úspěšně uložen do souboru: ${SUMMARY_REPORT_FILE}`);
    } catch (error) {
        console.error(`Chyba při ukládání souhrnného reportu:`, error.message);
    }
}

// Spusťte pro instalaci modulu csv-parse
// npx install csv-parse

// Funkce getWcagLevel musí být definována i zde, pokud není importována z jiného modulu
function getWcagLevel(wcagCode) {
    if (wcagCode.includes('WCAG2A')) return 'WCAG2A';
    if (wcagCode.includes('WCAG2AA')) return 'WCAG2AA';
    if (wcagCode.includes('WCAG2AAA')) return 'WCAG2AAA';
    return 'UNKNOWN';
}

generateDomainSummary();