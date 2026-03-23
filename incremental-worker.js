// =====================================================================
// INCREMENTAL EVIDENCE SYSTEM - BACKGROUND WORKER
// Processes queued topic updates in the background
// =====================================================================

const { Pool } = require('pg');
const crypto = require('crypto');

class IncrementalWorker {
  constructor(dbPool, anthropicClient) {
    this.db = dbPool;
    this.anthropic = anthropicClient;
    this.isRunning = false;
    this.currentJobs = 0;
    this.maxConcurrentJobs = 3;
    this.pollIntervalMs = 30000; // 30 seconds
  }

  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('🔄 Incremental Evidence Worker started');
    
    // Start the main processing loop
    this.processLoop();
  }

  async stop() {
    this.isRunning = false;
    console.log('⏹️  Incremental Evidence Worker stopped');
  }

  async processLoop() {
    while (this.isRunning) {
      try {
        await this.processNextBatch();
        await this.sleep(this.pollIntervalMs);
      } catch (error) {
        console.error('Worker error:', error.message);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  async processNextBatch() {
    if (!this.db || this.currentJobs >= this.maxConcurrentJobs) {
      return;
    }

    try {
      // Get pending updates
      const availableSlots = this.maxConcurrentJobs - this.currentJobs;
      const result = await this.db.query(`
        SELECT id, topic_id, update_type, priority, scheduled_for
        FROM update_queue 
        WHERE status = 'pending' 
          AND scheduled_for <= NOW()
        ORDER BY priority ASC, scheduled_for ASC
        LIMIT $1
      `, [availableSlots]);

      if (result.rows.length === 0) {
        return; // No work to do
      }

      console.log(`📊 Processing ${result.rows.length} queued updates...`);

      // Process each update
      for (const update of result.rows) {
        this.processUpdate(update); // Don't await - process in parallel
      }

    } catch (error) {
      console.error('Error fetching updates:', error.message);
    }
  }

  async processUpdate(update) {
    this.currentJobs++;
    
    try {
      // Mark as processing
      await this.db.query(`
        UPDATE update_queue 
        SET status = 'processing', 
            last_attempt = NOW(),
            attempts = attempts + 1
        WHERE id = $1
      `, [update.id]);

      console.log(`🔄 Processing update ${update.id}: ${update.update_type} for topic ${update.topic_id}`);

      // Get topic details
      const topicResult = await this.db.query(`
        SELECT canonical_query, plain_query, required_terms, synonyms
        FROM topics 
        WHERE id = $1
      `, [update.topic_id]);

      if (topicResult.rows.length === 0) {
        throw new Error(`Topic ${update.topic_id} not found`);
      }

      const topic = topicResult.rows[0];

      // Perform the update based on type
      let result;
      switch (update.update_type) {
        case 'initial_analysis':
        case 'scheduled':
          result = await this.performTopicAnalysis(topic, update.topic_id);
          break;
        case 'new_evidence':
          result = await this.processNewEvidence(topic, update.topic_id);
          break;
        default:
          throw new Error(`Unknown update type: ${update.update_type}`);
      }

      // Mark as completed
      await this.db.query(`
        UPDATE update_queue 
        SET status = 'completed', 
            completed_at = NOW()
        WHERE id = $1
      `, [update.id]);

      // Update topic's last incremental update
      await this.db.query(`
        UPDATE topics 
        SET last_incremental_update = NOW(),
            current_consensus_score = $2,
            current_consensus_pct = $3,
            current_certainty = $4,
            current_paper_count = $5
        WHERE id = $1
      `, [
        update.topic_id,
        result.consensus_score || null,
        result.consensus_pct || null,
        result.certainty || null,
        result.paper_count || 0
      ]);

      // Schedule next update if this is a recurring topic
      if (update.update_type === 'scheduled' || update.update_type === 'initial_analysis') {
        const nextUpdate = new Date();
        nextUpdate.setHours(nextUpdate.getHours() + 168); // Weekly by default

        await this.db.query(`
          INSERT INTO update_queue (topic_id, scheduled_for, update_type, priority)
          VALUES ($1, $2, 'scheduled', 3)
          ON CONFLICT (topic_id, update_type, scheduled_for) DO NOTHING
        `, [update.topic_id, nextUpdate]);
      }

      console.log(`✅ Completed update ${update.id} for topic ${update.topic_id}`);

    } catch (error) {
      console.error(`❌ Update ${update.id} failed:`, error.message);
      
      // Mark as failed
      await this.db.query(`
        UPDATE update_queue 
        SET status = 'failed',
            error_message = $2
        WHERE id = $1
      `, [update.id, error.message]);

      // Retry logic - schedule retry if attempts < 3
      if (update.attempts < 3) {
        const retryTime = new Date();
        retryTime.setHours(retryTime.getHours() + Math.pow(2, update.attempts)); // Exponential backoff
        
        await this.db.query(`
          INSERT INTO update_queue (topic_id, scheduled_for, update_type, priority)
          VALUES ($1, $2, $3, $4)
        `, [update.topic_id, retryTime, update.update_type, update.priority]);
      }

    } finally {
      this.currentJobs--;
    }
  }

  async performTopicAnalysis(topic, topicId) {
    // This is a simplified version - in a full implementation,
    // this would run the full Verity search pipeline
    console.log(`📊 Running analysis for: "${topic.canonical_query}"`);

    try {
      // For now, just return a placeholder result
      // In production, this would:
      // 1. Run the search pipeline (frameQuery, fetchAll, etc.)
      // 2. Store new papers in the papers table
      // 3. Update topic_papers relationships
      // 4. Compute consensus and store in consensus_history
      
      return {
        consensus_score: Math.floor(Math.random() * 200) - 100, // Placeholder: -100 to +100
        consensus_pct: Math.floor(Math.random() * 100), // Placeholder: 0-100%
        certainty: ['Very Low', 'Low', 'Moderate', 'High'][Math.floor(Math.random() * 4)],
        paper_count: Math.floor(Math.random() * 50) + 5, // Placeholder: 5-55 papers
        new_papers: 0,
        updated_at: new Date().toISOString()
      };

    } catch (error) {
      console.error(`Analysis failed for topic ${topicId}:`, error.message);
      throw error;
    }
  }

  async processNewEvidence(topic, topicId) {
    // Process newly discovered papers for this topic
    console.log(`🔍 Processing new evidence for: "${topic.canonical_query}"`);
    
    // Placeholder implementation
    return {
      consensus_score: Math.floor(Math.random() * 200) - 100,
      consensus_pct: Math.floor(Math.random() * 100),
      certainty: ['Very Low', 'Low', 'Moderate', 'High'][Math.floor(Math.random() * 4)],
      paper_count: Math.floor(Math.random() * 50) + 5,
      new_papers: Math.floor(Math.random() * 5) + 1,
      updated_at: new Date().toISOString()
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Health check
  getStatus() {
    return {
      running: this.isRunning,
      current_jobs: this.currentJobs,
      max_jobs: this.maxConcurrentJobs,
      poll_interval_ms: this.pollIntervalMs
    };
  }
}

module.exports = IncrementalWorker;
