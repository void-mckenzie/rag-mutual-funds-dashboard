import openai
import os
import json
from tqdm import tqdm # A library to show a smart progress bar

# --- Configuration ---
INPUT_DIRECTORY = "/home/mukmckenzie/Downloads/ecas_statements_decrypted/"
OUTPUT_FILE = "snapshot_data_updated.jsonl"


def get_llm_prompt(file_content: str) -> list:
    """Generates the prompt for the LLM with the given file content."""
    return [
        {
            "role": "system",
            "content": """You are a meticulous data extraction expert.
Your task is to analyze the provided financial statement and extract mutual fund holdings.
You MUST return the data as a single, clean JSON object.
Do not add any comments, explanations, or markdown formatting like ```json. The entire response must be only the JSON object itself.
Ensure numeric values are formatted as numbers (e.g., 126312.29), not strings with commas (e.g., "1,26,312.29").
"""
        },
        {
            "role": "user",
            "content": f"""
Please analyze the document content provided below. Your goal is to:
1. Find the statement date from the main heading (e.g., "MUTUAL FUND UNITS HELD AS ON 30-09-2024").
2. Locate the table with mutual fund holdings.
3. For each fund in the table, extract the required details.
4. Infer the `fundHouse` from the `schemeName`. The fund house will be one of: "AXIS Mutual Fund", "Edelweiss Mutual Fund", "Mirae Asset Mutual Fund", "Nippon India Mutual Fund", etc.

Format the result into a single JSON object matching this exact structure:

{{
  "statement_date": "YYYY-MM-DD",
  "holdings": [
    {{
      "fundHouse": "Name of the Fund House",
      "folioNumber": "The Folio No.",
      "ISIN": "The ISIN",
      "schemeName": "The full Scheme Name",
      "closingBalanceUnits": 1004.951,
      "nav": 125.69,
      "amountInvested": 71452.00,
      "currentValuation": 126312.29
    }}
  ]
}}

Here is the full document content:
    {file_content}

/no_think"""
        }
    ]

def main():
    """Main function to orchestrate the file processing and data extraction."""
    # --- Step 1: Initialize OpenAI Client ---
    try:
        client = openai.OpenAI(
            base_url="http://127.0.0.1:8080/v1",
            api_key="sk-no-key-required"
        )
        # A simple ping to check connection
        client.models.list()
        print("Successfully connected to the local OpenAI-compatible server.")
    except Exception as e:
        print(f"[FATAL ERROR] Failed to initialize or connect to OpenAI client: {e}")

    # --- Step 2: Find all .md files in the directory ---
    md_files = []
    for root, _, files in os.walk(INPUT_DIRECTORY):
        for filename in files:
            if filename.endswith(".md"):
                md_files.append(os.path.join(root, filename))

    if not md_files:
        print(f"[ERROR] No .md files found in the directory: {INPUT_DIRECTORY}")

    print(f"\nFound {len(md_files)} '.md' files to process.")

    # --- Step 3: Loop through files, extract data, and collect results ---
    all_extracted_data = []
    
    # Using tqdm for a progress bar
    for file_path in tqdm(md_files, desc="Processing files"):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                file_content = f.read()

            messages = get_llm_prompt(file_content)

            completion = client.chat.completions.create(
                model="local-model",
                messages=messages,
                temperature=0.0,
                stream=False
            )

            if not (completion.choices and completion.choices[0].message.content):
                print(f"\n[WARNING] No response from model for file: {file_path}")
                continue

            model_output = completion.choices[0].message.content.strip()
            json_start = model_output.find('{')
            json_end = model_output.rfind('}')

            if json_start != -1 and json_end != -1:
                json_string = model_output[json_start:json_end+1]
                parsed_data = json.loads(json_string)
                # Add the source filename for easy reference
                parsed_data['source_file'] = os.path.basename(file_path)
                all_extracted_data.append(parsed_data)
            else:
                print(f"\n[WARNING] No valid JSON object found in response for file: {file_path}")

        except json.JSONDecodeError as e:
            print(f"\n[ERROR] Failed to decode JSON for file {file_path}. Skipping. Error: {e}")
            continue
        except Exception as e:
            print(f"\n[ERROR] An unexpected error occurred while processing {file_path}. Skipping. Error: {e}")
            continue
    
    # --- Step 4: Sort the collected data by date ---
    if not all_extracted_data:
        print("\nNo data was successfully extracted from any file. Exiting.")
        
    print("\nSorting all extracted data by 'statement_date'...")
    try:
        # The 'YYYY-MM-DD' format sorts correctly as a string.
        sorted_data = sorted(all_extracted_data, key=lambda x: x.get('statement_date', ''))
    except Exception as e:
        print(f"[ERROR] Could not sort data. Check if 'statement_date' is present in all outputs. Error: {e}")
        # We will proceed with unsorted data in case of a sorting error
        sorted_data = all_extracted_data

    # --- Step 5: Write the sorted data to a JSONL file ---
    print(f"Writing {len(sorted_data)} records to '{OUTPUT_FILE}'...")
    try:
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            for record in sorted_data:
                # json.dumps converts the Python dict to a JSON string
                # ensure_ascii=False is good practice for non-English characters
                json_line = json.dumps(record, ensure_ascii=False)
                f.write(json_line + '\n')
        
        print("\n--- Process Complete! ---")
        print(f"Successfully created the JSON Lines file: {OUTPUT_FILE}")
        
    except Exception as e:
        print(f"\n[FATAL ERROR] Failed to write to the output file '{OUTPUT_FILE}'. Error: {e}")


# --- Script Entry Point ---
if __name__ == "__main__":
    main()