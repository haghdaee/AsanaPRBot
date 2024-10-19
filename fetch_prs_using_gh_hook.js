import express from 'express';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import OpenAI from 'openai';
import crypto from 'crypto';

// Use environment variables for tokens and configuration
const {
  APP_ID,
  PRIVATE_KEY,
  WEBHOOK_SECRET,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json()); // Parse JSON bodies

// Function to verify the webhook signature
function verifySignature(req, res, buf, encoding) {
  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(buf);
  const digest = 'sha256=' + hmac.digest('hex');
  if (signature !== digest) {
    throw new Error('Invalid signature');
  }
}

// Use the verifySignature function
app.use(express.json({ verify: verifySignature }));

// Route to handle GitHub webhooks
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event === 'pull_request' && payload.action === 'review_requested') {
    const prNumber = payload.pull_request.number;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const requestedReviewer = payload.requested_reviewer.login;

    // Check if the requested reviewer is 'haghdaee'
    if (requestedReviewer !== 'haghdaee') {
      return res.status(200).send('Not the correct reviewer.');
    }

    // Process the pull request
    await processPullRequest(prNumber, owner, repo);
    return res.status(200).send('Processed pull request.');
  }

  res.status(200).send('Event ignored.');
});

// Function to process a single PR
async function processPullRequest(prNumber, owner, repo) {
  console.log(`Processing PR #${prNumber}...\n`);

  try {
    // Authenticate as GitHub App
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: APP_ID,
        privateKey: PRIVATE_KEY,
        installationId: INSTALLATION_ID, // You'll need to set this
      },
    });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


    // Fetch PR details
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Check if the bot has already commented
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
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
        { role: "user", content: finalPrompt },
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    // Post the AI response as a comment on the PR
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: aiResponse,
    });

    console.log(`Comment posted to PR #${prNumber}`);

    // Remember to adjust OWNER and REPO variables to use the parameters
  } catch (error) {
    console.error(`Error processing PR #${prNumber}:`, error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
