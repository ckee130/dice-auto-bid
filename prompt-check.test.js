import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { missingFromProfile, withDefaults } from "./src/profile.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESUME_PROMPT as prompt } from "./src/resume-prompt.js";
import { employmentRules, validatePromptResume, generatePromptResume, toRenderResume } from "./src/prompt-generation.js";
import { buildPromptResumePdf, DEFAULT_THEME } from "./src/vendor/generation.js";
import { themeFrom } from "./src/writer.js";

const rules = employmentRules(prompt, [{ company: "Wrong employer", startDate: "Nov 2013", endDate: "Nov 2026", bulletCount: 5 }]);
const verbs = ["Designed", "Eliminated", "Resolved", "Rebuilt", "Overhauled", "Restructured", "Replaced", "Refactored", "Reduced", "Optimized", "Built", "Diagnosed", "Automated", "Standardized", "Unified"];
function fixture() {
  let slot = 0;
  return {
    company_name: "Hiring company", role_title: "Engineer", resume_title: "Engineer · Infrastructure",
    summary: Array(60).fill("engineering").join(" "),
    skill_groups: Array.from({length:4}, (_, i) => ({category: `Tools ${i}`,items: Array.from({length:5},(_, j)=>`Tool${i}${j}`)})),
    additional_categories: Array.from({length:3},(_,i)=>({category:`Competencies ${i}`,items:["Incident Response","System Design","Code Review","Collaboration"]})),
    experience: rules.map((rule,i)=>({
      company:rule.company, dates:`${rule.startDate} - ${rule.endDate}`,location:"City, ST",role_title:rule.internship?"Software Engineering Intern":"Engineer",
      role_description:Array(rule.internship?16:24).fill("context").join(" "),
      bullets:Array.from({length:rule.bulletCount},(_,j)=> {
        const verb=verbs[slot++];
        const outcome = i===0 && j<3 || i===1 && j===0 ? "cutting latency by 20%." : i===0 && j<5 ? "cutting latency from 900ms to 500ms." : "with documented test coverage.";
        return `${verb} request validation for customer workflow modules through bounded retry checks and explicit schema constraints during integration testing ${outcome}`;
      })
    }))
  };
}
const candidate = {name:"Test Candidate",email:"test@example.com",phone:"555",location:"City, ST",education:{degree:"Degree",school:"School",year:"2013",location:"City"}};
test("main prompt locks override profile's 5/4/3 slots and altered dates",()=> {
 assert.deepEqual(rules.map(r=>[r.company,r.startDate,r.endDate,r.bulletCount]),[["Google","Oct 2013","Present",10],["Shelby.tv","May 2012","Aug 2012",3],["FaceBook","May 2011","Aug 2011",2]]);
 assert.equal(validatePromptResume(fixture(),rules,prompt).length,0);
});
test("screenshot regressions are rejected rather than silently rendered",()=> {
 const r=fixture(); r.experience[0].bullets=r.experience[0].bullets.slice(0,5);r.experience[0].dates="Nov 2013 - Nov 2026";r.experience[1].bullets.push("Built a fourth bullet.");r.experience[2].bullets[0]+=" 5 dashboards";delete r.experience[0].role_description;
 const errors=validatePromptResume(r,rules,prompt).join(" ");
 for(const expected of ["exactly 10 bullets","exactly 3 bullets","Oct 2013 - Present","role_description required","digit-free"]) assert.ok(errors.includes(expected),expected);
});
test("historically impossible internship tools fail validation",()=> {
 const r=fixture();r.experience[1].bullets[1]+=" FastAPI";
 assert.ok(validatePromptResume(r,rules,prompt).some(e=>e.includes("too recent")));
});
test("adapter preserves role descriptions and separates competencies from technical skills",()=> {
 const raw=fixture(),r=toRenderResume(raw,candidate);
 assert.equal(r.experience[0].scope,raw.experience[0].role_description);
 assert.equal(r.coreSkills.length,4);assert.equal(r.competencies.length,3);
 assert.equal(r.experience[0].startDate,"Oct 2013");assert.equal(r.experience[0].endDate,"Present");
});
test("repair calls use the main prompt verbatim and no legacy rules",async()=> {
 let calls=0;
 const result=await generatePromptResume("Target JD",{systemPrompt:prompt,slots:[],candidate},undefined,async request=>{
   assert.equal(request.system,prompt);
   assert.ok(!request.messages[0].content.includes("at least 3 carrying a defensible count"));
   const r=fixture();if(!calls++)r.experience[0].bullets.pop();
   return {text:JSON.stringify(r),inputTokens:10,outputTokens:20};
 });
 assert.equal(calls,2);assert.equal(result.usage.calls,2);assert.equal(result.resume.experience[0].bullets.length,10);
});
test("exhausted repairs fail instead of returning a noncompliant best draft",async()=> {
 await assert.rejects(generatePromptResume("JD",{systemPrompt:prompt,slots:[],candidate},undefined,async()=>({text:"{}"})),/does not satisfy the main prompt/);
});
test("PDF renders full prompt structure with separate competency section",async()=> {
 const bytes=await buildPromptResumePdf(toRenderResume(fixture(),candidate),DEFAULT_THEME);
 assert.equal(new TextDecoder().decode(bytes.slice(0,4)),"%PDF");
 const dir=mkdtempSync(join(tmpdir(),"resume-prompt-check-"));
 try {
   const file=join(dir,"resume.pdf");writeFileSync(file,bytes);
   const text=execFileSync("pdftotext",[file,"-"],{encoding:"utf8"});
   const headings=["PROFESSIONAL SUMMARY","WORK EXPERIENCE","TECHNICAL SKILLS","EDUCATION","CORE COMPETENCIES"];
   let previous=-1;for(const heading of headings){const index=text.indexOf(heading);assert.ok(index>previous,heading);previous=index;}
   assert.ok(text.includes("Oct 2013 - Present"));
   assert.ok(text.includes("FaceBook"));
   assert.equal((text.match(/context/g)??[]).length,56);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("selected font and accent are preserved",()=> {
 const theme=themeFrom({fontFamily:"Georgia",accentColor:"10625B"});
 assert.equal(theme.fontFamily,"Georgia");assert.equal(theme.accentColor,"10625B");
});

test("fixed prompt employment does not require duplicate profile rows; unlocked prompts do",()=> {
 const p=withDefaults({apiKey:"sk-ant-api03-test",experience:[]});
 assert.equal(missingFromProfile(p).length,0);
 assert.ok(missingFromProfile({...p,resumePrompt:"Write a resume using my job rows."}).some(e=>e.includes("company name")));
});
