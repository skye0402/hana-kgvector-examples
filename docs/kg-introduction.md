DEFAULT Graph and Named Graphs
==============================

SAP HANA Cloud knowledge graph engine supports a DEFAULT graph and named graphs.

DEFAULT Graph
-------------

The built-in DEFAULT graph (an unnamed graph) is always present and accessible for all users with PUBLIC access privileges. The DEFAULT graph is readable and writable by all users. Triples stored in the DEFAULT graph can be accessed with FROM DEFAULT in the SPARQL statements. Any data inserted into the knowledge graph without specifying a name for the graph is inserted into the DEFAULT graph.

The following SQL console example inserts triples into the DEFAULT graph:

    CALL SPARQL_EXECUTE('
      INSERT DATA {
        <P1> a <Person>; <name> "Joe Bud"; <email> "joe.bud@example.com" . }
    ', '', ?, ?);

The following SQL console example selects all triples from the DEFAULT graph:

    SELECT * FROM SPARQL_TABLE('
      SELECT ?s ?p ?o 
      FROM DEFAULT 
      WHERE { ?s ?p ?o . }  
      ORDER BY ?s
    '); 

Named Graphs
------------

With named graphs, triples can be stored according to their meaning. With FROM or FROM NAMED, queries can specify any combination of named graphs together with the DEFAULT graph to create an RDF-merge of the graphs to operate on.

Use the GRANT statement to grant permissions to a named graph.

The following SQL console example inserts triples into the named graph john\_movies:

    CALL SPARQL_EXECUTE('
      INSERT DATA { GRAPH <john_movies> { 
        <P1> a <Director>; <name> "Martin Scorsese".
        <P2> a <Director>; <name> "Steven Spielberg". 
        <P3> a <Director>; <name> "Quentin Tarantino". 
        <P4> a <Director>; <name> "Woody Allen".  }
        }
    ', '', ?, ?);

The following SQL console example selects all triples from the given named graphs:

    SELECT * FROM SPARQL_TABLE('
      SELECT ?s ?p ?o 
      FROM <john_movies>
      FROM <kgdocu_movies>
      WHERE { ?s ?p ?o . }
    '); 

The following SQL console example selects all triples from the DEFAULT graph and all named graphs:

    SELECT * FROM SPARQL_TABLE('
      SELECT ?s ?p ?o 
      WHERE { ?s ?p ?o . } 
    ');

The following SQL console example selects all triples from all named graphs and adds the name of the graphs to the output:

    SELECT * FROM SPARQL_TABLE('
      SELECT ?s ?p ?o  ?g 
      WHERE { GRAPH ?g { ?s ?p ?o . } }
    ');

Knowledge Graph Engine Transaction Processing
=============================================

SAP HANA Cloud knowledge graph engine is tightly integrated with SAP HANA database to provide the experience of a single transaction across other engines such as column store, document database, and so on.

Interoperability with SAP HANA Database Objects
-----------------------------------------------

You can use the same transaction to perform updates to a knowledge graph and other SAP HANA database objects such as tables, views, and so on. Executing a single COMMIT or ROLLBACK command for a transaction guarantees atomic commit behavior across SAP Knowledge Graph and other SAP HANA database objects.

### Example

1.  Disable AUTOCOMMIT mode for the session. For example, if you're using the SAP HANA HDBSQL command-line tool, you can do this using the \-z option described [here](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html"). If you're using the SQL console from SAP HANA Database Explorer, you can do this by editing the connection settings as described [here](https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html "https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html").
    
2.  Create a column store table called T1 and insert data into it :
    
        CREATE COLUMN TABLE T1 (ID INT); 
    
3.  Insert data into knowledge graph <MYGRAPH> and table T1, then run a COMMIT.
    
        INSERT INTO T1 VALUES(1); 
         
        CALL SPARQL_EXECUTE(' 
        INSERT DATA { 
            GRAPH <MYGRAPH> { 
                <P1> A <PERSON>; <NAME> "JOHN"; <AGE> 32 .  
            } 
        }', '', ?, ?); 
        
        COMMIT;
    
    Inserting the data into a knowledge graph automatically creates it, if it doesn't already exist.
    
4.  Roll back the transaction:
    
        INSERT INTO T1 VALUES(2); 
        CALL SPARQL_EXECUTE(' 
        INSERT DATA { 
            GRAPH <MYGRAPH> { 
                <P2> A <PERSON>; <NAME> "SMITH"; <AGE> 35 .  
            } 
        }', '', ?, ?); 
        
        ROLLBACK;
    
    This rolls back the transaction on both the column store table and the knowledge graph.
    
5.  Run a select statement on table T1:
    
        SELECT * FROM T1; 
    
    This should show committed transactions only:
    
    ID
    
    1
    
6.  Run a select on MYGRAPH:
    
        SELECT * FROM SPARQL_TABLE(' 
            SELECT ?S ?P ?O 
            FROM <MYGRAPH> 
            WHERE { 
                ?S ?P ?O 
            } 
        '); 
    
    This should show committed transactions only:
    
    S
    
    P
    
    O
    
    P1
    
    http://www.w3.org/1999/02/22-rdf-syntax-ns#type
    
    PERSON
    
    P1
    
    NAME
    
    JOHN
    
    P1
    
    AGE
    
    32
    

Isolation Levels
----------------

[](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/20fdf9cb75191014b85aaa9dec841291.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Sets transaction parameters.")

*   [](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html")[](https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html "https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html")
    

Transactional Savepoints
------------------------

A savepoint is a location to which a transaction can return if part of the transaction is conditionally canceled. You can create one using the SAP HANA Cloud, SAP HANA database [SAVEPOINT statement](https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/cd4172aead1e47e99f6599656887f343.html "https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/cd4172aead1e47e99f6599656887f343.html").

SAP HANA Cloud knowledge graph engine supports rolling back a transaction to the named savepoint without terminating the transaction. To do this, use the SAP HANA database [ROLLBACK TO SAVEPOINT statement](https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/104ae26787e24bddbda2953c0397b6e8.html "https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/104ae26787e24bddbda2953c0397b6e8.html").

To release a specified savepoint, use the SAP HANA database [RELEASE SAVEPOINT statement](https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/445eb4d2202f4f29b67e9874a3c9acfb.html "https://help.sap.com/docs/HANA_CLOUD_DATABASE/c1d3f60099654ecfb3fe36ac93c121bb/445eb4d2202f4f29b67e9874a3c9acfb.html").

### Example

1.  Disable AUTOCOMMIT mode for the session. For example, if you're using the SAP HANA HDBSQL command-line tool, you can do this using the \-z option described [here](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c24d054bbb571014b253ac5d6943b5bd.html"). If you're using the SQL console from SAP HANA Database Explorer, you can do this by editing the connection settings as described [here](https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html "https://help.sap.com/docs/HANA_CLOUD/a2cea64fa3ac4f90a52405d07600047b/2f39e4fdd67545cf805b557357c5a7b3.html").
    
2.  Insert some triples in graph <MYGRAPH>:
    
        CALL SPARQL_EXECUTE(' 
        INSERT DATA { 
            GRAPH <MYGRAPH> { 
                <P1> A <PERSON>; <NAME> "JOHN"; <AGE> 32 .  
            } 
        }', '', ?, ?); 
    
3.  Set a savepoint:
    
        SAVEPOINT SAVE1; 
    
4.  Insert some triples in graph <MYGRAPH>:
    
        CALL SPARQL_EXECUTE(' 
        INSERT DATA { 
            GRAPH <MYGRAPH> { 
                <P2> A <PERSON>; <NAME> "SMITH"; <AGE> 34 .  
            } 
        }', '', ?, ?); 
    
5.  Run a select statement to show all the inserted triples:
    
        SELECT * FROM SPARQL_TABLE(' 
            SELECT ?S ?P ?O 
            FROM <MYGRAPH> 
            WHERE { 
                ?S ?P ?O 
            } 
        '); 
    
6.  Roll back the current transaction to savepoint save1:
    
        ROLLBACK TO SAVEPOINT SAVE1; 
    
7.  Run a select statement on graph <MYGRAPH> to show triples inserted before savepoint save1 only:
    
        SELECT * FROM SPARQL_TABLE(' 
            SELECT ?S ?P ?O 
            FROM <MYGRAPH>
            WHERE { 
                ?S ?P ?O 
            } 
        '); 
    

Autocommit Requirements
-----------------------

The AUTOCOMMIT setting does not impact any of the following operations:

*   [INSERT Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/insert-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Inserts triples using graph and triple patterns.")
    
*   [INSERT DATA Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/insert-data-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Inserts specific triples.")
    
*   [DELETE Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/9633553b13d24ae78339f948660d0de6.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Deletes triples using graph and triple patterns.")
    
*   [DELETE DATA Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/delete-data-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Deletes specific triples.")
    
*   [CLEAR Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/clear-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Deletes all of the triples in a graph without deleting the graph.")
    
*   [COPY Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/90267a903bef4a4baeb322391f59e8c5.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Copy data from a SAP HANA Cloud knowledge graph engine graph into a file.")
    
*   [CREATE INFERENCES Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/247e0506b59048a49a8616aefbcd08d9.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Create inferences from either the DEFAULT graph or a list of named graphs, using an optional set of OWL 2 RL and RDFS-Plus inferencing rules.")
    
*   [LOAD Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/94727f008f104723a5383c77cbba6a79.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Load data from a file into a SAP HANA Cloud knowledge graph engine graph.")
    
*   [ASK Query Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/ask-query-form?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Run ASK queries when you want to know whether a certain pattern exists in the data. ASK queries return only "true" or "false" to indicate whether a solution exists.")
    
*   [CONSTRUCT Query Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/construct-query-form?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Use the CONSTRUCT query form to create new data from your existing data. Run CONSTRUCT queries when you want to create or transform data based on the existing data.")
    
*   [DESCRIBE Query Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/describe-query-form?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Use the DESCRIBE query form to return an RDF graph that describes the resources matched by the graph pattern of the query.")
    
*   [SELECT Query Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/select-query-form?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Like SQL, SPARQL provides a SELECT query form for selecting or finding data. Run SELECT queries when you want to find and return all of the data that matches certain patterns.")
    

However, when executing the operations below, the AUTOCOMMIT setting must be enabled or the session fails:

*   [CREATE GRAPH Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/create-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Creates an empty named graph.")
    
*   [DROP GRAPH Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/drop-update-operation?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Deletes a graph and all of its triples.")
    
*   [GRANT Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/380f222c51c24eab82d81a90d50f6d83.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Grants SPARQL privileges to graph objects to selected SAP HANA database users.")
    
*   [REVOKE Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/4002824b69ec4c89a4e33d63f578e487.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Revokes SPARQL privileges to named objects from selected SAP HANA database users.")
    
*   [VACUUM Update Form](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/422fce67b8b2430280eb3abb86814e58.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "An administrative command that defragments storage and improves query performance by reclaiming the memory consumed by deleted triples.")
    

SAP HANA Cloud knowledge graph engine does not support SAP HANA Cloud, SAP HANA database's [SET TRANSACTION AUTOCOMMIT DDL Statement (Transaction Management)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/d538d11053bd4f3f847ec5ce817a3d4c.html?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Specifies the auto commit property for DDL statements specific to the session.").

Catalog Object Locks
--------------------

Modifications to catalog objects are protected by object-level locks. The DROP, GRANT and REVOKE operations use an exclusive lock on catalog objects while all other SAP HANA Cloud knowledge graph engine operations use a shared lock.

In scenarios where two or more transactions are executing concurrently and referencing the same objects, it is possible that locking these objects may result in a deadlock. This can happen if the objects referenced in the concurrent transactions are in different order. To resolve the deadlock, SAP HANA Cloud knowledge graph engine would cancel one or more transactions.

Python Interface
================

Use the Python interface to connect to an SAP HANA database and execute SPARQL queries and update options.

SAP HANA database supports multiple connectivity interfaces, including Python, Node.js, Java, and so on, that allow you to develop your own stand-alone applications. All these interfaces use drivers like JDBC or ODBC to connect to SAP HANA Cloud and can provide a higher-level API to use with the programming language of your choice. While you can use these interfaces, we recommend using the SQL console in SAP HANA Cloud Central or the SAP HANA HDBSQL command-line interface.

The Python command-line interface takes your SPARQL query, wraps and packages it as SQL, and then runs the SQL statement.

For information about installing and connecting to the Python client interface, see [Python Application Programming](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html") and the [SAP HANA Client Interface Programming Reference](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/ce5509c492af4a9f84ee519d5659f186.html "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/ce5509c492af4a9f84ee519d5659f186.html").

Example
-------

    from hdbcli import dbapi
     
    # connect to database using username/password
    conn = dbapi.connect(user='db-username', password='db-user-password', address='database host', port=port_number, ...)
     
    # call stored procedure to execute SPARQL Query
    resp = conn.cursor().callproc('SPARQL_EXECUTE', ('SPARQL Query or RDF Turtle Data', 'Metadata headers describing Input and/or Output', '?', None) )
    # resp[3] --> OUT: SAP HANA Cloud knowledge graph engine Response Metadata/Headers
    # resp[2] --> OUT: SAP HANA Cloud knowledge graph engine Response
    # resp[1] --> IN: Metadata headers describing Input and/or Output
    # resp[0] --> IN: SPARQL Query or RDF Turtle Data

Best Practices for SPARQL Queries
=================================

Achieve your desired SPARQL query results by familiarizing yourself with these best practices.

When compared with SQL, SPARQL syntax and grammar are less enforceable. In a graph database, since the data defines the schema, the data can't be evaluated against the schema. Additionally, because RDF graphs typically contain semi structured data, databases can include incomplete or unknown data.

Look for Typographical Errors
-----------------------------

Mistyping a predicate, for example, doesn't produce an error such as "predicate does not exist." Instead, the query might not produce any results.

The following query counts the distinct number of likes in the sample movies data. As shown in the WHERE clause, the predicate in the movies graph is "<like>". The results show that there are 10 distinct likes, or 10 distinct objects for the <like> predicate:

    SELECT * FROM SPARQL_TABLE('
      SELECT (count(?o) as ?numberOfLikes)
      FROM <http://sap.com/movies>
      WHERE { {
        SELECT DISTINCT ?o
        WHERE { ?s <http://sap.com/movies/like> ?o }
       }
      }
      numberOfLikes');
    --------------
    10
    1 rows

Misspelling "like" as "likes" doesn't produce an error, but the query returns no results:

    SELECT * FROM SPARQL_TABLE('
      SELECT (count(?o) as ?numberOfLikes)
      FROM <http://sap.com/movies>
      WHERE { {
        SELECT DISTINCT ?o
        WHERE { ?s <http://sap.com/movies/likes> ?o }
       }
      }
      numberOfLikes');
    --------------
    0
    1 rows

Make Some Triple Patterns Optional
----------------------------------

Some queries might need to account for missing or incomplete data. To ensure that triples aren't excluded from the results because they follow some (but not all) of the query's triple patterns, you can use the OPTIONAL keyword to make certain triple patterns optional.

For example, the sample movies dataset includes person graphs. These graphs contain triples with a person subject and predicates such as first name, last name, birthday, credit card number, like, and dislike. Some person graphs are missing the like or dislike predicates, so querying for person data using like or dislike in the pattern may produce unexpected results.

This example queries the movies dataset to find the first and last name and likes and dislikes for all of the people who bought tickets:

    SELECT * FROM SPARQL_TABLE('
      PREFIX movies: <http://sap.com/movies/>
      SELECT ?fname ?lname ?like ?dislike
      FROM <http://sap.com/movies>
      WHERE {
        ?sale movies:buyerid ?person .
        ?person movies:firstname ?fname .
        ?person movies:lastname ?lname .
        ?person movies:like ?like .
        ?person movies:dislike ?dislike .
      }
      GROUP BY ?fname ?lname ?like ?dislike');

The patterns in the WHERE clause ask for person data where the triples include firstname, lastname, like, and dislike. Any person triples that are missing any of the patterns are excluded from the results. This query returns **188536** rows.

Using OPTIONAL clauses in the query changes the criteria so that all firstname and lastname are returned and like or dislike data is returned if it exists. This query makes like and dislike optional:

    SELECT * FROM SPARQL_TABLE('
      PREFIX movies: <http://sap.com/movies/>
      SELECT ?fname ?lname ?like ?dislike
      FROM <http://sap.com/movies>
      WHERE {
        ?sale movies:buyerid ?person .
        ?person movies:firstname ?fname .
        ?person movies:lastname ?lname .
        OPTIONAL { ?person movies:like ?like }
        OPTIONAL { ?person movies:dislike ?dislike }
      }
      GROUP BY ?fname ?lname ?like ?dislike);

This query returns **202862** rows because it includes person triples with firstname and lastname values and doesn't exclude triples that are missing like or dislike predicates.

Avoid Unexpected Results When Constructing Data
-----------------------------------------------

CONSTRUCT queries return a single RDF graph specified by the template that you supply. The result takes each query solution and substitutes for the variables in the template and then combines the triples into a graph. If you specify a pattern that produces a triple that contains an unbound variable or an illegal RDF construct such as a literal value in the subject or predicate position, then you may get unexpected results because the problematic triples are excluded from the output graph.

