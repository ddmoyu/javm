R"SQL(
CREATE TEMP VIEW javm_catalog AS
SELECT b.*,CASE WHEN catalog_pixels>=2160 THEN '4K' WHEN catalog_pixels>0 THEN catalog_pixels||'p' ELSE '' END AS catalog_quality
FROM (SELECT w.*,w.code AS local_id,w.provenance AS nfo_data,
 CASE WHEN w.runtime_seconds>0 OR json_type(w.provenance,'$._manual.duration') IS NOT NULL THEN w.runtime_seconds ELSE COALESCE(m.duration_ms/1000,0) END AS duration,
 m.path AS video_path,COALESCE(m.dir_path,'') AS dir_path,m.file_size,m.file_mtime,m.fast_hash,
 COALESCE(m.width,0) AS width,COALESCE(m.height,0) AS height,COALESCE(m.duration_ms,0) AS duration_ms,
 COALESCE(m.codec,'') AS codec,COALESCE(m.missing,0) AS missing,
 CASE WHEN m.id IS NULL THEN 'metadata_only' WHEN m.missing=0 THEN 'available' ELSE 'unavailable' END AS availability,
 CASE WHEN m.width>0 AND m.height>0 THEN m.width||'x'||m.height ELSE '' END AS resolution,
 COALESCE(n.path,'') AS nfo_path,COALESCE(n.stamp,'') AS nfo_stamp,COALESCE(m.file_stamp,'') AS file_stamp,
 COALESCE(NULLIF(CAST(substr(w.premiered,1,4) AS INTEGER),0),json_extract(w.provenance,'$.year'),0) AS catalog_year,
 javm_pixels(COALESCE(m.width,0),COALESCE(m.height,0),'') AS catalog_pixels,
 COALESCE((SELECT e.name FROM entities e JOIN work_entities r ON r.entity_id=e.id WHERE r.work_id=w.id AND e.kind='actors' ORDER BY r.priority,e.name LIMIT 1),'') AS catalog_actor,
 w.studio AS catalog_studio,w.label AS catalog_label,w.director AS catalog_director,w.series AS catalog_series
FROM works w
LEFT JOIN media_files m ON m.id=(SELECT f.id FROM media_files f WHERE f.work_id=w.id ORDER BY f.missing,f.created_at,f.id LIMIT 1)
LEFT JOIN nfo_documents n ON n.work_id=w.id AND n.canonical=1) b;
CREATE TEMP TABLE javm_discovery_overrides(dimension TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,video_count INTEGER,PRIMARY KEY(dimension,name)) WITHOUT ROWID;
CREATE TEMP VIEW javm_discovery_names AS SELECT * FROM javm_discovery_overrides;
)SQL"
