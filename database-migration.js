// =====================================================================
// DATABASE MIGRATION SYSTEM FOR VERITY
// This replaces the simple initDB() function with a comprehensive
// migration system that handles both cache tables and incremental tables
// =====================================================================

const fs = require('fs');
const path = require('path');

class VerityDatabaseMigration {
  constructor(pool) {
    this.pool = pool;
    this.migrations = [
      {
        version: 1,
        description: 'Create basic cache table',
        sql: this.getCacheTableSQL()
      },
      {
        version: 2,
        description: 'Create incremental evidence system tables',
        sql: this.getIncrementalSystemSQL()
      }
    ];
  }

  async runMigrations() {
    if (!this.pool) {
      console.log('📊 Database not available, skipping migrations');
      return;
    }

    try {
      // Create migration tracking table
      await this.createMigrationTable();
      
      // Get current migration version
      const currentVersion = await this.getCurrentVersion();
      console.log(`📊 Database at migration version: ${currentVersion}`);
      
      // Run pending migrations
      const pendingMigrations = this.migrations.filter(m => m.version > currentVersion);
      
      if (pendingMigrations.length === 0) {
        console.log('✅ Database is up to date');
        return;
      }
      
      console.log(`📊 Running ${pendingMigrations.length} pending migrations...`);
      
      for (const migration of pendingMigrations) {
        await this.runMigration(migration);
      }
      
      console.log('✅ All database migrations completed successfully');
      
    } catch (error) {
      console.error('❌ Database migration failed:', error.message);
      throw error;
    }
  }

  async createMigrationTable() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async getCurrentVersion() {
    try {
      const result = await this.pool.query(
        'SELECT MAX(version) as version FROM schema_migrations'
      );
      return result.rows[0].version || 0;
    } catch (error) {
      return 0; // No migrations table exists yet
    }
  }

  async runMigration(migration) {
    console.log(`📊 Applying migration ${migration.version}: ${migration.description}`);
    
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Execute the migration SQL
      await client.query(migration.sql);
      
      // Record the migration
      await client.query(
        'INSERT INTO schema_migrations (version, description) VALUES ($1, $2)',
        [migration.version, migration.description]
      );
      
      await client.query('COMMIT');
      console.log(`✅ Migration ${migration.version} completed successfully`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`❌ Migration ${migration.version} failed:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  getCacheTableSQL() {
    return `
      -- Basic cache table for query results
      CREATE TABLE IF NOT EXISTS query_cache (
        id           SERIAL PRIMARY KEY,
        query_hash   CHAR(64) UNIQUE NOT NULL,
        query_raw    TEXT NOT NULL,
        query_plain  TEXT,
        result_json  JSONB NOT NULL,
        paper_count  INT,
        certainty    TEXT,
        score        INT,
        hit_count    INT DEFAULT 1,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_query_hash ON query_cache(query_hash);
      CREATE INDEX IF NOT EXISTS idx_updated ON query_cache(updated_at);
    `;
  }

  getIncrementalSystemSQL() {
    return `
      -- Core topics table - tracks high-value research questions
      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY,
        
        -- Query identification
        query_hash VARCHAR(64) NOT NULL UNIQUE,
        canonical_query TEXT NOT NULL,
        plain_query TEXT NOT NULL,
        
        -- Topic metadata  
        domain VARCHAR(50),
        intervention VARCHAR(200),
        required_terms TEXT[],
        synonyms TEXT[],
        
        -- Consensus tracking
        current_consensus_score INTEGER,
        current_consensus_pct INTEGER,
        current_certainty VARCHAR(20),
        current_paper_count INTEGER DEFAULT 0,
        
        -- Update metadata
        last_full_analysis TIMESTAMP,
        last_incremental_update TIMESTAMP,
        update_frequency_hours INTEGER DEFAULT 168,
        
        -- Status flags
        is_active BOOLEAN DEFAULT true,
        priority_level INTEGER DEFAULT 3,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Papers table
      CREATE TABLE IF NOT EXISTS papers (
        id SERIAL PRIMARY KEY,
        
        -- Paper identification
        doi VARCHAR(200),
        pmid VARCHAR(20),
        title TEXT NOT NULL,
        abstract TEXT,
        paper_hash VARCHAR(64) UNIQUE,
        
        -- Paper metadata
        journal VARCHAR(200),
        year INTEGER,
        authors TEXT,
        
        -- Design classification
        design VARCHAR(20),
        sample_size INTEGER,
        citations INTEGER DEFAULT 0,
        
        -- Quality metrics
        weight DECIMAL(4,3) DEFAULT 1.0,
        is_retracted BOOLEAN DEFAULT false,
        
        -- Source tracking
        source VARCHAR(20),
        
        -- Discovery metadata
        first_discovered TIMESTAMP DEFAULT NOW(),
        last_updated TIMESTAMP DEFAULT NOW()
      );

      -- Create partial unique indexes for papers
      CREATE UNIQUE INDEX IF NOT EXISTS papers_doi_unique ON papers(doi) WHERE doi IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS papers_pmid_unique ON papers(pmid) WHERE pmid IS NOT NULL;

      -- Junction table linking topics to papers
      CREATE TABLE IF NOT EXISTS topic_papers (
        id SERIAL PRIMARY KEY,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        paper_id INTEGER REFERENCES papers(id) ON DELETE CASCADE,
        
        -- Relationship metadata
        relevance_score DECIMAL(3,2),
        population_match DECIMAL(3,2),
        intervention_match DECIMAL(3,2),
        
        -- Outcome extraction
        extracted_outcomes JSONB,
        outcome_direction VARCHAR(20),
        outcome_magnitude DECIMAL(3,2),
        outcome_precision DECIMAL(3,2),
        
        -- Temporal tracking
        added_to_topic TIMESTAMP DEFAULT NOW(),
        last_outcome_extraction TIMESTAMP,
        
        UNIQUE(topic_id, paper_id)
      );

      -- Consensus history
      CREATE TABLE IF NOT EXISTS consensus_history (
        id SERIAL PRIMARY KEY,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        
        -- Snapshot data
        consensus_score INTEGER,
        consensus_pct INTEGER,
        certainty VARCHAR(20),
        paper_count INTEGER,
        evidence_count INTEGER,
        
        -- Change metadata
        trigger_type VARCHAR(30),
        trigger_paper_id INTEGER REFERENCES papers(id),
        change_magnitude INTEGER,
        
        -- Algorithm metadata  
        algorithm_version VARCHAR(30),
        deep_mode BOOLEAN DEFAULT false,
        
        -- Timestamp
        recorded_at TIMESTAMP DEFAULT NOW()
      );

      -- Update queue
      CREATE TABLE IF NOT EXISTS update_queue (
        id SERIAL PRIMARY KEY,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        
        -- Scheduling
        scheduled_for TIMESTAMP NOT NULL,
        priority INTEGER DEFAULT 3,
        update_type VARCHAR(30),
        
        -- Status tracking
        status VARCHAR(20) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_attempt TIMESTAMP,
        completed_at TIMESTAMP,
        error_message TEXT,
        
        -- Processing metadata
        estimated_duration_ms INTEGER,
        cost_estimate_usd DECIMAL(6,4),
        
        created_at TIMESTAMP DEFAULT NOW(),
        
        UNIQUE(topic_id, update_type, scheduled_for)
      );

      -- Add missing column if it doesn't exist (for existing installations)
      DO $$ 
      BEGIN
        BEGIN
          ALTER TABLE update_queue ADD COLUMN completed_at TIMESTAMP;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
      END $$;

      -- New papers watch
      CREATE TABLE IF NOT EXISTS new_papers_watch (
        id SERIAL PRIMARY KEY,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        paper_id INTEGER REFERENCES papers(id) ON DELETE CASCADE,
        
        -- Discovery metadata
        discovered_at TIMESTAMP DEFAULT NOW(),
        discovery_source VARCHAR(30),
        search_query TEXT,
        
        -- Prioritization
        estimated_relevance DECIMAL(3,2),
        requires_full_analysis BOOLEAN DEFAULT true,
        
        -- Processing status
        processed BOOLEAN DEFAULT false,
        processed_at TIMESTAMP,
        
        UNIQUE(topic_id, paper_id)
      );

      -- System configuration
      CREATE TABLE IF NOT EXISTS system_config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(100) UNIQUE NOT NULL,
        config_value TEXT,
        description TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Insert default configuration (only if not exists)
      INSERT INTO system_config (config_key, config_value, description) 
      SELECT * FROM (VALUES
        ('incremental_enabled', 'true', 'Whether incremental updates are enabled'),
        ('max_concurrent_updates', '3', 'Maximum number of concurrent topic updates'),
        ('consensus_shift_threshold', '10', 'Minimum score change to trigger notifications'),
        ('meta_analysis_priority', '1', 'Priority level for new meta-analyses'),
        ('rct_priority', '2', 'Priority level for new RCTs'),
        ('observational_priority', '4', 'Priority level for new observational studies'),
        ('default_update_frequency_hours', '168', 'Default hours between updates (168 = weekly)'),
        ('cost_limit_daily_usd', '50.00', 'Daily API cost limit for incremental updates')
      ) AS t(config_key, config_value, description)
      WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE system_config.config_key = t.config_key);

      -- Performance indexes
      CREATE INDEX IF NOT EXISTS idx_topics_domain ON topics(domain);
      CREATE INDEX IF NOT EXISTS idx_topics_priority ON topics(priority_level, is_active);
      CREATE INDEX IF NOT EXISTS idx_topics_last_update ON topics(last_incremental_update);
      CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year DESC);
      CREATE INDEX IF NOT EXISTS idx_papers_design ON papers(design);
      CREATE INDEX IF NOT EXISTS idx_papers_citations ON papers(citations DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_papers_topic ON topic_papers(topic_id);
      CREATE INDEX IF NOT EXISTS idx_topic_papers_relevance ON topic_papers(topic_id, relevance_score DESC);
      CREATE INDEX IF NOT EXISTS idx_consensus_history_topic ON consensus_history(topic_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_update_queue_scheduling ON update_queue(scheduled_for, priority, status);
      CREATE INDEX IF NOT EXISTS idx_new_papers_watch_unprocessed ON new_papers_watch(topic_id, processed, discovered_at DESC);

      -- Helper functions
      CREATE OR REPLACE FUNCTION generate_query_hash(query_text TEXT)
      RETURNS VARCHAR(64) AS $$
      BEGIN
        RETURN encode(digest(lower(trim(query_text)), 'sha256'), 'hex');
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;

      CREATE OR REPLACE FUNCTION generate_paper_hash(title_text TEXT, abstract_text TEXT)
      RETURNS VARCHAR(64) AS $$
      BEGIN
        RETURN encode(digest(lower(trim(title_text || ' ' || COALESCE(abstract_text, ''))), 'sha256'), 'hex');
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;

      -- Triggers
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS update_topics_updated_at ON topics;
      CREATE TRIGGER update_topics_updated_at BEFORE UPDATE ON topics
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_papers_last_updated ON papers;  
      CREATE TRIGGER update_papers_last_updated BEFORE UPDATE ON papers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;
  }

  // Health check function
  async checkHealth() {
    if (!this.pool) return { status: 'disabled', message: 'Database not configured' };
    
    try {
      await this.pool.query('SELECT 1');
      const version = await this.getCurrentVersion();
      return { 
        status: 'healthy', 
        message: `Database connected, migration version: ${version}` 
      };
    } catch (error) {
      return { 
        status: 'error', 
        message: `Database error: ${error.message}` 
      };
    }
  }
}

module.exports = VerityDatabaseMigration;
