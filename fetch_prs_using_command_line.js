import { Octokit } from "@octokit/rest";
import OpenAI from "openai";

// Use environment variables for tokens
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Get PR number from command-line arguments
const PR_NUMBER = process.argv[2];

// Repository details
const OWNER = "Asana";
const REPO = "codez";

// Initialize Octokit and OpenAI
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Function to process a single PR
async function processPullRequest(prNumber) {
  console.log(`Processing PR #${prNumber}...\n`);

  try {
    // Fetch PR details
    const { data: pr } = await octokit.pulls.get({
      owner: OWNER,
      repo: REPO,
      pull_number: prNumber,
    });

    // Check if the bot has already commented
    const { data: comments } = await octokit.issues.listComments({
      owner: OWNER,
      repo: REPO,
      issue_number: prNumber,
    });

    const botCommentExists = comments.some(
      (comment) => comment.user.login === 'github-actions[bot]' // Adjust if your bot uses a different username
    );

    if (botCommentExists) {
      console.log(`Bot has already commented on PR #${prNumber}. Skipping.`);
      return;
    }

    // Compile the prompt (use your existing logic here)
    let prompt = "";

    // Summary
    const summary = `### Pull Request #${pr.number}: ${pr.title}

**Description:**
${pr.body || "No description provided."}

`;

    // Diff
    const { data: diff } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: OWNER,
        repo: REPO,
        pull_number: prNumber,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      }
    );

    const diffContent = `**Diff:**
\`\`\`diff
${diff}
\`\`\`

`;

    // Contextual Background
    const context = `**Labels:** ${pr.labels.map((label) => label.name).join(", ") || "None"}
**Assignees:** ${pr.assignees.map((assignee) => assignee.login).join(", ") || "None"}
**Reviewers:** ${pr.requested_reviewers.map((reviewer) => reviewer.login).join(", ") || "None"}

`;

    // Comments (excluding bot comments)
    const humanComments = comments.filter(
      (comment) => comment.user.type !== "Bot" && comment.user.login !== 'github-actions[bot]'
    );

    const commentsList = humanComments
      .map((comment) => `- **${comment.user.login}:** ${comment.body}`)
      .join("\n");

    const commentsSection = commentsList
      ? `**Comments:**
${commentsList}

`
      : "";

    // Compile the prompt for this PR
    prompt += `${summary}${diffContent}${context}${commentsSection}\n---\n\n`;

    // Final prompt to be provided to the assistant
    const finalPrompt = `I have the following pull request that I'd like feedback on. Please review the information and provide your insights.

${prompt}

Please focus on any potential issues, improvements, or suggestions you might have.

Organize your feedback into "DO", "TRY", "CONSIDER" and "QUESTIONS" sections. For example:
- DO: Suggest a better variable name for the \`x\` variable.
- TRY: Try using a different approach to handle the error.
- CONSIDER: Consider extracting the common logic into a separate function.
- QUESTIONS: What happens if the input is null?

`;


    // Send the prompt to OpenAI
    const completion = await openai.chat.completions.create({
      model: "o1-preview",
      messages: [
        // { role: "system", content: "You are an expert code reviewer." },
        { role: "user", content: finalPrompt },
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    // Post the AI response as a comment on the PR
    await octokit.issues.createComment({
      owner: OWNER,
      repo: REPO,
      issue_number: prNumber,
      body: aiResponse,
    });

    console.log(`Comment posted to PR #${prNumber}`);
  } catch (error) {
    console.error(`Error processing PR #${prNumber}:`, error);
    process.exit(1);
  }
}

// Main function to handle the PR
(async () => {
  const prNumber = PR_NUMBER;

  if (!prNumber) {
    console.error('PR_NUMBER is not set. Please provide the PR number as a command-line argument.');
    process.exit(1);
  }

  await processPullRequest(prNumber);
})();
