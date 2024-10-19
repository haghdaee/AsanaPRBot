import { Octokit } from "@octokit/rest";
import fs from "fs";

// Use environment variable for the token
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Repository details
const OWNER = "Asana";
const REPO = "codez";

// List of PR numbers you want to process
const PR_NUMBERS = [281667]; // Add other PR numbers as needed

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

(async () => {
  let prompt = "";

  for (const prNumber of PR_NUMBERS) {
    console.log(`Processing PR #${prNumber}...\n`);

    try {
      // Fetch PR details
      const { data: pr } = await octokit.pulls.get({
        owner: OWNER,
        repo: REPO,
        pull_number: prNumber,
      });

      // Summary
      const summary = `### Pull Request #${pr.number}: ${pr.title}

**Description:**
${pr.body}

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
      const { data: comments } = await octokit.issues.listComments({
        owner: OWNER,
        repo: REPO,
        issue_number: prNumber,
      });

      // Function to check if a user is a bot
      const isHumanUser = (user) => {
        // GitHub marks bots with a type of 'Bot'
        return user.type !== "Bot";
      };

      const humanComments = comments.filter((comment) => isHumanUser(comment.user));

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
    } catch (error) {
      console.error(`Error processing PR #${prNumber}:`, error);
    }
  }

  // Final prompt to be provided to the assistant
  const finalPrompt = `I have the following pull request(s) that I'd like feedback on. Please review the information and provide your insights.

${prompt}

Please focus on any potential issues, improvements, or suggestions you might have.

Organize your feedback into "DO", "TRY", "CONSIDER" and "QUESTIONS" sections. For example:
- DO: Suggest a better variable name for the \`x\` variable.
- TRY: Try using a different approach to handle the error.
- CONSIDER: Consider extracting the common logic into a separate function.
- QUESTIONS: What happens if the input is null?

`;

  // Save the prompt to a file
  fs.writeFileSync("pr_feedback_prompt.txt", finalPrompt);
  console.log("Prompt saved to pr_feedback_prompt.txt");

  // Optionally, output the prompt to the console
  // Comment out the following lines if you prefer not to print the prompt
  console.log("\n===== Prompt Start =====\n");
  console.log(finalPrompt);
  console.log("\n===== Prompt End =====\n");
})();
