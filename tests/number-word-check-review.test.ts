import { expect, test } from "bun:test";
import { firstWordOmitted, wordMismatches } from "../src/quality/take-checks.js";
const words = (text: string) => text.split(" ").filter(Boolean).map((word, i) => ({ word, start: i, end: i + 1 }));
// Every case from reviewer probes 1 and 2. Lead rulings supersede exploratory probe wishes:
// decades, fractions, general segmented digit sums, grey/gray and short names are out of scope;
// preserve master's long-word waiver (including settings/setting). Currency remains bounded.
const cases: [string, string, boolean][] = [
  ["It is four hundred.", "It is 40.", false],
  ["I went two places.", "I went to places.", false],
  ["It is fifteen.", "It is 50.", false],
  ["It cost $4.", "It cost four hundred dollars.", false],
  ["It cost four hundred dollars.", "It cost $4.", false],
  ["The 1st take.", "The first take.", true],
  ["In the 90s.", "In the nineties.", false],
  ["In the nineties.", "In the 90s.", false],
  ["In the '90s.", "In the nineties.", false],
  ["In twenty twenty-six.", "In 2025.", false],
  ["In twenty twenty-six.", "In 2016.", false],
  ["In nineteen ninety-nine.", "In 1998.", false],
  ["They knew it.", "They new it.", false],
  ["It is right there.", "It is write there.", false],
  ["Version one point zero ships.", "Version one ships.", false],
  ["Version one point zero ships.", "Version 1 ships.", false],
  ["Node 18.10 ships.", "Node 18.1 ships.", false],
  ["Node 1.50 ships.", "Node 1.5 ships.", false],
  ["It cost four hundred dollars.", "It cost 400.", true],
  ["It cost four dollars today.", "It cost 4 today.", true],
  ["It cost four hundred euros.", "It cost 400.", false],
  ["The GPT-4 model.", "The GPT 4 model.", true],
  ["The M4 chip.", "The M 4 chip.", true],
  ["The M4 chip.", "The M-4 chip.", true],
  ["COVID-19 rules.", "COVID 19 rules.", true],
  ["The 3D view.", "The 3-D view.", true],
  ["Kubernetes runs.", "Kubernetis runs.", true],
  ["Anthropic ships.", "Antropic ships.", true],
  ["BrainLayer works.", "Brain Layer works.", true],
  ["Orc is ready.", "Ork is ready.", false],
  ["The settings work.", "The setting work.", true],
  ["Analyse it.", "Analyze it.", true],
  ["Practise it.", "Practice it.", true],
  ["The theatre grey.", "The theater gray.", false],
  ["Twenty percent of takes.", "20% of takes.", true],
  ["Twenty percent of takes.", "20 of takes.", false],
  ["Four thousand takes.", "4,000 takes.", true],
  ["Four thousand takes.", "4000 takes.", true],
  ["Four hundred thousand takes.", "400 takes.", false],
  ["One hundred and five takes.", "105 takes.", true],
  ["Three takes.", "3 takes.", true],
  ["Three hundred and seventy two takes.", "372 takes.", true],
  ["Three hundred and seventy two takes.", "300 72 takes.", false],
  ["Two four takes.", "24 takes.", false],
  ["Twenty four takes.", "20 4 takes.", true],
  ["The tenth take.", "The 10 take.", false],
  ["Ten takes.", "10th takes.", false],
  ["One take.", "1 take.", true],
  ["A take.", "1 take.", false],
  ["A hundred takes.", "100 takes.", true],
  ["Half a million.", "500,000.", false],
  ["Two thousand and twenty six.", "2026.", true],
  ["Twenty one.", "21.", true],
  ["It cost $400.", "It cost 400.", true],
  ["It cost $400.", "It cost four hundred.", false],
  ["It is 0.5%.", "It is zero point five percent.", true],
  ["Item 1,234.", "Item 1234.", true],
  ["It is 1.0 now.", "It is one now.", false],
  ["It is 2.50 now.", "It is two point five now.", false],
  ["Prioritise it.", "Prioritize it.", true],
  ["Customise it.", "Customize it.", true],
  ["Minimise it.", "Minimize it.", true],
  ["Categorise it.", "Categorize it.", true],
  ["My favourite one.", "My favorite one.", true],
  ["It was labelled.", "It was labeled.", true],
  ["It was cancelled.", "It was canceled.", true],
  ["Travelling fast.", "Traveling fast.", true],
  ["Modelling work.", "Modeling work.", true],
  ["The defence holds.", "The defense holds.", true],
  ["The programme runs.", "The program runs.", false],
  ["Practise daily.", "Practice daily.", true]
];
for (const [sent, heard, pass] of cases) {
  test(`review probe: ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, words(heard), { setting: "a" }).pass).toBe(pass);
  });
}
// The first-word gate is a separately reported defect; these probes pin its current result.
const openingCases: [string, string, boolean][] = [
  ["Three hundred and seventy two takes.", "372 takes.", true],
  ["Four hundred dollars today.", "$400 today.", true],
  ["Four hundred dollars today.", "400 dollars today.", true],
  ["Twenty twenty-six was long.", "2026 was long.", true],
  ["Twenty five takes.", "25 takes.", false],
  ["Fifteen takes.", "15 takes.", false],
  ["The colour is red.", "The color is red.", false],
  ["A hundred takes.", "100 takes.", true],
  ["Fourth take.", "4th take.", true]
];
for (const [sent, heard, omitted] of openingCases) {
  test(`review opening probe: ${sent} / ${heard}`, () => {
    expect(firstWordOmitted(sent, words(heard)).omitted).toBe(omitted);
    expect(wordMismatches(sent, words(heard)).pass).toBe(true);
  });
}
