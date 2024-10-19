import express from 'express';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import Redis from 'ioredis';

const {
  ASANA_PERSONAL_ACCESS_TOKEN,
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  REDIS_URL,
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json());

// Initialize Redis client
const redis = new Redis(REDIS_URL, {
  tls: {
    rejectUnauthorized: false,
  },
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Route to handle Asana webhooks
app.post('/webhook', async (req, res) => {
  console.log('Received Asana webhook event.');
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
    // Generate a unique key for the event
    const eventKey = `${event.resource.gid}`;

    // Check if we've already processed this event
    const isProcessed = await redis.sismember('processedEvents', eventKey);
    if (isProcessed) {
      console.log(`Event ${eventKey} has already been processed. Skipping.`);
      continue;
    }

    console.log('Processing event:', JSON.stringify(event));

    const resource = event.resource;
    if (
      resource.resource_type === 'task' &&
      event.action === 'added'
    ) {
      // Handle new tasks
      await processAsanaTask(resource.gid);

      // Mark the event as processed
      await redis.sadd('processedEvents', eventKey);
    } else if (
      resource.resource_type === 'story' &&
      event.action === 'added' &&
      resource.resource_subtype === 'comment_added'
    ) {
      // Handle new comments
      await processAsanaStory(resource.gid);

      // Mark the event as processed
      await redis.sadd('processedEvents', eventKey);
    } else {
      console.log('Ignoring event:', JSON.stringify(event));
    }
  }

  res.status(200).send('Events processed.');
});

// Function to process the Asana story (comment)
async function processAsanaStory(storyId) {
  console.log(`Processing Asana Story #${storyId}...\n`);

  try {
    // Fetch story details from Asana API
    const storyDetails = await getAsanaStoryDetails(storyId);

    // Check if the story is a comment
    if (storyDetails.type !== 'comment') {
      console.log('Story is not a comment. Skipping.');
      return;
    }

    const commentText = storyDetails.text;

    // Check if the comment contains "@AsanaPRBot"
    if (!commentText.includes('@AsanaPRBot')) {
      console.log('Comment does not contain @AsanaPRBot. Skipping.');
      return;
    }

    // Extract the instruction after '@AsanaPRBot'
    const instructionMatch = commentText.match(/@AsanaPRBot\s*(.*)/i);
    const instruction = instructionMatch ? instructionMatch[1].trim() : null;

    // Get the task ID the story is associated with
    const taskId = storyDetails.target.gid;

    // Fetch task details from Asana
    const taskDetails = await getAsanaTaskDetails(taskId);

    // Now process the task, passing the instruction as context
    await processAsanaTask(taskId, instruction);
  } catch (error) {
    console.error(`Error processing Asana Story #${storyId}:`, error);
  }
}

// Function to fetch Asana story details
async function getAsanaStoryDetails(storyId) {
  const response = await fetch(`https://app.asana.com/api/1.0/stories/${storyId}`, {
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    },
  });
  const data = await response.json();
  return data.data;
}

// Function to process the Asana task
async function processAsanaTask(taskId, context = null) {
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
    await processPullRequest(prNumber, owner, repo, context);
  } catch (error) {
    console.error(`Error processing Asana Task #${taskId}:`, error);
  }
}

// Function to fetch Asana task details
async function getAsanaTaskDetails(taskId) {
  const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}?opt_fields=tags,workspace,notes`, {
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
async function processPullRequest(prNumber, owner, repo, context = null) {
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

    // Additional Context from Asana
    const asanaContext = context
      ? `**Additional Context from Asana:**
${context}

`
      : "";

    // Compile the prompt for this PR
    prompt += `${summary}${diffContent}${contextSection}${commentsSection}${asanaContext}\n---\n\n`;

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
      model: "o1-preview",
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
  }
}
