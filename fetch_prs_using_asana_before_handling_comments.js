import express from 'express';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import fetch from 'node-fetch'; // Ensure this is installed: npm install node-fetch
import crypto from 'crypto';

const {
  ASANA_PERSONAL_ACCESS_TOKEN,
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json()); // Parse JSON bodies

// Route to handle Asana webhooks
app.post('/webhook', async (req, res) => {
  // Handle Asana webhook verification
  console.log('Received Asana webhook event.');
  console.log('body:', req.body);
  const xHookSecret = req.headers['x-hook-secret'];
  if (xHookSecret) {
    console.log('Verifying Asana webhook...');
    res.set('X-Hook-Secret', xHookSecret);
    return res.status(200).send();
  }

  const events = req.body.events;
  if (!events || events.length === 0) {
    console.log('No events to process.');
    return res.status(200).send('No events to process.');
  }

  // Process each event
  for (const event of events) {
    // Process only when a task is added or changed
    console.log('Processing event:', JSON.stringify(event));
    const resource = event.resource;
    if ((resource.resource_type === 'task') && (event.action === 'added')) {
      const taskId = event.resource;

      // Fetch task details from Asana
      await processAsanaTask(resource.gid);
    } else {
      console.log('Ignoring event:', JSON.stringify(event));
    }
  }

  res.status(200).send('Events processed.');
});

// Function to process the Asana task
async function processAsanaTask(taskId) {
  console.log(`Processing Asana Task #${taskId}...\n`);

  try {
    // Fetch task details from Asana API
    const taskDetails = await getAsanaTaskDetails(taskId);

    // Extract the PR URL from the task description or custom fields
    const prUrl = extractPrUrlFromTask(taskDetails);

    if (!prUrl) {
      console.log('No PR URL found in the task.');
      return;
    }

    // Extract owner, repo, and PR number from the URL
    const { owner, repo, prNumber } = parseGithubUrl(prUrl);

    if (!owner || !repo || !prNumber) {
      console.log('Invalid PR URL.');
      return;
    }

    // Process the PR
    await processPullRequest(prNumber, owner, repo);
  } catch (error) {
    console.error(`Error processing Asana Task #${taskId}:`, error);
  }
}

// Function to fetch Asana task details
async function getAsanaTaskDetails(taskId) {
  const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    },
  });
  const data = await response.json();
  return data.data;
}

// Function to extract PR URL from the task
function extractPrUrlFromTask(taskDetails) {
  // Assuming the PR URL is in the task description
  const description = taskDetails.notes;
  const prUrlMatch = description.match(/https:\/\/github\.com\/[^\s]+/);
  if (prUrlMatch) {
    return prUrlMatch[0];
  }
  return null;
}

// Function to parse the PR URL
function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (match) {
    const [, owner, repo, prNumber] = match;
    return { owner, repo, prNumber };
  }
  return {};
}

// Function to process a single PR
async function processPullRequest(prNumber, owner, repo) {
  console.log(`Processing PR #${prNumber} in ${owner}/${repo}...\n`);

  try {
    // Authenticate with GitHub
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Fetch PR details
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Check if 'haghdaee' is a reviewer or assignee
    const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
    const assignees = pr.assignees.map((assignee) => assignee.login);

    // at first I was gonna just restrict to haghdaee but then I thought it would be better to have it review on a team basis
    // if (!reviewers.includes('haghdaee') && !assignees.includes('haghdaee')) {
    //   console.log(`'haghdaee' is not a reviewer or assignee on PR #${prNumber}. Skipping.`);
    //   return;
    // }

    // Check if the bot has already commented
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    //doesn't work for now
    const botUsername = 'your-bot-username'; // Replace with your bot's username

    const botCommentExists = comments.some(
      (comment) => comment.user.login === botUsername
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
**Assignees:** ${assignees.join(", ") || "None"}
**Reviewers:** ${reviewers.join(", ") || "None"}

`;

    // Comments (excluding bot comments)
    const humanComments = comments.filter(
      (comment) => comment.user.type !== "Bot" && comment.user.login !== botUsername
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
Please focus on any potential issues, improvements, or suggestions you might have. Be succinct and clear in your feedback.
If you have any questions or need more information, feel free to ask. If the PR is ready to merge, please indicate that as well.
If you see that the PR addresses disparate issues that are best addressed in separate, nudge the author to split the PR into smaller, more focused PRs, using Graphite.
`;

    // Send the prompt to OpenAI
    const completion = await openai.chat.completions.create({
      model: "o1-preview", // Use "gpt-3.5-turbo" if necessary
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
  } catch (error) {
    console.error(`Error processing PR #${prNumber}:`, error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
