#!/usr/bin/env node
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command-line arguments
const argv = yargs(hideBin(process.argv))
  .option('pr-number', {
    alias: 'p',
    type: 'number',
    description: 'Pull Request Number',
    demandOption: true,
  })
  .option('github-token', {
    alias: 'g',
    type: 'string',
    description: 'GitHub Token',
    demandOption: true,
  })
  .option('openai-token', {
    alias: 'o',
    type: 'string',
    description: 'OpenAI API Token',
    demandOption: true,
  })
  .option('comment-id', {
    alias: 'c',
    type: 'number',
    description: 'Comment ID (if processing a specific comment)',
  })
  .option('owner', {
    type: 'string',
    description: 'GitHub repository owner',
    demandOption: !process.env.GITHUB_REPOSITORY_OWNER,
    default: process.env.GITHUB_REPOSITORY_OWNER,
  })
  .option('repo', {
    type: 'string',
    description: 'GitHub repository name',
    demandOption: !(process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.split('/')[1]),
    default: process.env.GITHUB_REPOSITORY
      ? process.env.GITHUB_REPOSITORY.split('/')[1]
      : undefined,
  })
  .help()
  .alias('help', 'h')
  .argv;


// Main function to process the PR or comment
(async () => {
  const {
    prNumber,
    githubToken,
    openaiToken,
    commentId,
    owner,
    repo,
  } = argv;

  // Authenticate with GitHub
  const octokit = new Octokit({ auth: githubToken });
  const openai = new OpenAI({ apiKey: openaiToken });

  try {
    if (commentId) {
      // Process the specific comment
      await processComment(prNumber, commentId, owner, repo, octokit, openai);
    } else {
      // Process the PR
      await processPullRequest(prNumber, owner, repo, octokit, openai);
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
})();

// Function to process a specific comment
async function processComment(prNumber, commentId, owner, repo, octokit, openai) {
  console.log(`Processing comment #${commentId} on PR #${prNumber}...\n`);

  // Fetch the comment details
  const { data: comment } = await octokit.issues.getComment({
    owner,
    repo,
    comment_id: commentId,
  });

  const commentText = comment.body;

  // Check if the comment contains "@AsanaPRBot"
  if (!commentText.includes('@AsanaPRBot')) {
    console.log('Comment does not contain @AsanaPRBot. Skipping.');
    return;
  }

  // Extract the instruction after '@AsanaPRBot'
  const instructionMatch = commentText.match(/@AsanaPRBot\s*(.*)/i);
  const instruction = instructionMatch ? instructionMatch[1].trim() : null;

  // Now process the PR with the instruction
  await processPullRequest(prNumber, owner, repo, octokit, openai, instruction);
}

// Function to process a PR
async function processPullRequest(prNumber, owner, repo, octokit, openai, context = null) {
  console.log(`Processing PR #${prNumber} in ${owner}/${repo}...\n`);

  try {
    // Fetch PR details
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Fetch comments on the PR
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    // Compile the prompt
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
        owner,
        repo,
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
    const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
    const assignees = pr.assignees.map((assignee) => assignee.login);

    const contextSection = `**Labels:** ${pr.labels.map((label) => label.name).join(", ") || "None"}
**Assignees:** ${assignees.join(", ") || "None"}
**Reviewers:** ${reviewers.join(", ") || "None"}

`;

    // Include all comments without filtering out bot comments
    const commentsList = comments
      .map((comment) => `- **${comment.user.login}:** ${comment.body}`)
      .join("\n");

    const commentsSection = commentsList
      ? `**Comments:**
${commentsList}

`
      : "";

    // Additional Context from Comment
    const additionalContext = context
      ? `**Additional Context from Comment:**
${context}

`
      : "";

    // Compile the prompt for this PR
    prompt += `${summary}${diffContent}${contextSection}${commentsSection}${additionalContext}\n---\n\n`;

    // Final prompt to be provided to the assistant
    let finalPrompt;
    if (context) {
      finalPrompt = `As an expert code reviewer, please focus on the following instruction while reviewing the pull request:

"${context}"

Here is the PR information:

${prompt}

Provide a concise and specific response addressing the instruction above. Avoid unnecessary information or general feedback. Ensure accuracy and refrain from including any information not present in the PR data.

`;
    } else {
      finalPrompt = `As an expert code reviewer, please review the following pull request:

${prompt}

Please focus on potential issues, improvements, or suggestions. Be succinct and clear in your feedback. If the PR is ready to merge, please indicate that as well. If you notice the PR addresses disparate issues better handled separately, suggest splitting it into smaller, focused PRs.

Provide a concise response without unnecessary elaboration or hallucinations.

`;
    }

    // Send the prompt to OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "user", content: finalPrompt },
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    // Introduce the bot and its functionalities
    const botIntroduction = "👋 Hi, I'm **AsanaPRBot**, your assistant for concise PR reviews.";

    // Post the AI response as a comment on the PR
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `${botIntroduction}\n\n${aiResponse}`,
    });

    console.log(`Comment posted to PR #${prNumber}`);
  } catch (error) {
    console.error(`Error processing PR #${prNumber}:`, error);
    throw error;
  }
}
